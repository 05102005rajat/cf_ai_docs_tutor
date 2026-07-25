import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TOP_K = 5;

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type Source = { n: number; url: string };

type HistoryEntry = ChatMessage & { sources?: Source[] };

export class DocsTutorAgent extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
    try {
      this.sql.exec(`ALTER TABLE messages ADD COLUMN sources TEXT`);
    } catch {
      // column already exists on pre-existing sessions
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/chat") {
      const history = this.loadHistory();
      return Response.json({ messages: history });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
      }
      const message = (body as { message?: unknown } | null)?.message;
      if (typeof message !== "string" || message.trim().length === 0) {
        return Response.json(
          { error: "\"message\" must be a non-empty string" },
          { status: 400 },
        );
      }
      const { reply, sources } = await this.handleMessage(message);
      return Response.json({ reply, sources });
    }

    return new Response("Not found", { status: 404 });
  }

  private loadHistory(): HistoryEntry[] {
    // Take the most recent 50 messages (by id), then re-sort ascending so
    // callers get them in chronological order.
    const rows = this.sql
      .exec(
        `SELECT role, content, sources FROM (
           SELECT id, role, content, sources FROM messages ORDER BY id DESC LIMIT 50
         ) ORDER BY id ASC`,
      )
      .toArray() as Array<{ role: string; content: string; sources: string | null }>;
    return rows.map((r) => ({
      role: r.role as ChatMessage["role"],
      content: r.content,
      sources: r.sources ? (JSON.parse(r.sources) as Source[]) : undefined,
    }));
  }

  private saveMessage(role: ChatMessage["role"], content: string, sources?: Source[]) {
    this.sql.exec(
      "INSERT INTO messages (role, content, sources) VALUES (?, ?, ?)",
      role,
      content,
      sources ? JSON.stringify(sources) : null,
    );
  }

  private async handleMessage(userMessage: string): Promise<{ reply: string; sources: Source[] }> {
    this.saveMessage("user", userMessage);

    // 1. Embed the user query.
    const embedResp = (await this.env.AI.run(EMBED_MODEL, {
      text: [userMessage],
    })) as { data: number[][] };
    const queryVector = embedResp.data[0];

    // 2. Retrieve top-K doc chunks from Vectorize.
    const retrieval = await this.env.VECTORIZE.query(queryVector, {
      topK: TOP_K,
      returnMetadata: "all",
    });

    const sources: Source[] = retrieval.matches.map((m, i) => {
      const md = m.metadata as { url?: string } | undefined;
      return { n: i + 1, url: md?.url ?? "" };
    });

    const context = retrieval.matches
      .map((m, i) => {
        const md = m.metadata as { text?: string; url?: string } | undefined;
        return `[${i + 1}] (${md?.url ?? "unknown"})\n${md?.text ?? ""}`;
      })
      .join("\n\n---\n\n");

    // 3. Build the prompt with system + retrieved context + recent history.
    const history = this.loadHistory();
    const recent: ChatMessage[] = history.slice(-8).map(({ role, content }) => ({ role, content }));

    const systemPrompt = `You are the Cloudflare Docs Tutor, a helpful assistant that answers questions about Cloudflare's developer platform using the context below.

Rules:
- For greetings or small talk (e.g. "hi", "yo", "thanks"), reply with a brief friendly greeting and invite the user to ask a question about Cloudflare's developer platform. Do not cite sources for greetings.
- For technical questions, answer ONLY based on the retrieved context. If the answer isn't in the context, say "I don't see that in the docs I've indexed."
- Cite sources inline using [1], [2] etc. referring to the numbered chunks.
- Keep answers concise and include code snippets when relevant.

Retrieved context:
${context}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...recent,
    ];

    // 4. Call the LLM.
    const chatResp = (await this.env.AI.run(CHAT_MODEL, {
      messages,
      max_tokens: 800,
    })) as { response: string };

    const reply = chatResp.response ?? "(no response)";
    this.saveMessage("assistant", reply, sources);
    return { reply, sources };
  }
}

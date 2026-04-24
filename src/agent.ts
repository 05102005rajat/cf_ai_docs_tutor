import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TOP_K = 5;

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

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
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/chat") {
      const history = this.loadHistory();
      return Response.json({ messages: history });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const { message } = (await request.json()) as { message: string };
      const reply = await this.handleMessage(message);
      return Response.json({ reply });
    }

    return new Response("Not found", { status: 404 });
  }

  private loadHistory(): ChatMessage[] {
    const rows = this.sql
      .exec("SELECT role, content FROM messages ORDER BY id ASC LIMIT 50")
      .toArray() as Array<{ role: string; content: string }>;
    return rows.map((r) => ({ role: r.role as ChatMessage["role"], content: r.content }));
  }

  private saveMessage(role: ChatMessage["role"], content: string) {
    this.sql.exec("INSERT INTO messages (role, content) VALUES (?, ?)", role, content);
  }

  private async handleMessage(userMessage: string): Promise<string> {
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

    const context = retrieval.matches
      .map((m, i) => {
        const md = m.metadata as { text?: string; url?: string } | undefined;
        return `[${i + 1}] (${md?.url ?? "unknown"})\n${md?.text ?? ""}`;
      })
      .join("\n\n---\n\n");

    // 3. Build the prompt with system + retrieved context + recent history.
    const history = this.loadHistory();
    const recent = history.slice(-8);

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
    this.saveMessage("assistant", reply);
    return reply;
  }
}

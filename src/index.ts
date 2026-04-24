import { DocsTutorAgent } from "./agent";
import { ingestDocs } from "./ingest";

export { DocsTutorAgent };

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  BROWSER: Fetcher;
  ASSETS: Fetcher;
  DocsTutorAgent: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Admin endpoint: seed the Vectorize index with Cloudflare docs.
    // Hit this once after deploy to populate the index.
    if (url.pathname === "/__ingest" && request.method === "POST") {
      const count = await ingestDocs(env);
      return Response.json({ ok: true, chunks_indexed: count });
    }

    // Chat endpoint — one Durable Object per session ID (cookie or query param).
    if (url.pathname === "/chat") {
      const sessionId = url.searchParams.get("session") ?? "default";
      const id = env.DocsTutorAgent.idFromName(sessionId);
      const stub = env.DocsTutorAgent.get(id);
      return stub.fetch(request);
    }

    // Everything else → static assets (the chat UI).
    return env.ASSETS.fetch(request);
  },
};

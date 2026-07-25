import { DocsTutorAgent } from "./agent";
import { ingestDocs } from "./ingest";

export { DocsTutorAgent };

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  BROWSER: Fetcher;
  ASSETS: Fetcher;
  DocsTutorAgent: DurableObjectNamespace;
  // Shared secret required to call the /__ingest admin endpoint. Set via
  // `wrangler secret put INGEST_TOKEN`. If unset, the endpoint is disabled.
  INGEST_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Admin endpoint: seed the Vectorize index with Cloudflare docs.
    // Requires `Authorization: Bearer <INGEST_TOKEN>` — set the secret with
    // `wrangler secret put INGEST_TOKEN` before this endpoint will work.
    if (url.pathname === "/__ingest" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      const expected = env.INGEST_TOKEN;
      if (!expected || authHeader !== `Bearer ${expected}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const result = await ingestDocs(env);
      return Response.json({
        ok: result.failed.length === 0,
        chunks_indexed: result.totalChunks,
        pages_succeeded: result.succeeded.length,
        pages_failed: result.failed,
      });
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

import type { Env } from "./index";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

// A hand-picked seed set of Cloudflare developer docs pages.
// Small enough to index in one shot from within a Worker request budget.
// Add/remove URLs here to change the knowledge corpus.
const SEED_URLS = [
  "https://developers.cloudflare.com/agents/",
  "https://developers.cloudflare.com/agents/getting-started/quickstart/",
  "https://developers.cloudflare.com/agents/concepts/what-are-agents/",
  "https://developers.cloudflare.com/agents/api-reference/agents-api/",
  "https://developers.cloudflare.com/workers-ai/",
  "https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/",
  "https://developers.cloudflare.com/vectorize/",
  "https://developers.cloudflare.com/vectorize/get-started/intro/",
  "https://developers.cloudflare.com/workflows/",
  "https://developers.cloudflare.com/durable-objects/",
  "https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/",
  "https://developers.cloudflare.com/browser-rendering/",
];

export type IngestResult = {
  totalChunks: number;
  succeeded: string[];
  // Pages that produced zero chunks, whether because the fetch/embed threw
  // or because the fetched text was too short to be useful.
  failed: { url: string; reason: string }[];
};

export async function ingestDocs(env: Env): Promise<IngestResult> {
  let totalChunks = 0;
  const succeeded: string[] = [];
  const failed: { url: string; reason: string }[] = [];

  for (const url of SEED_URLS) {
    try {
      const text = await fetchAsPlainText(url, env);
      if (!text || text.length < 200) {
        failed.push({ url, reason: "fetched text too short (page blocked, 404, or empty)" });
        continue;
      }

      const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
      let urlChunks = 0;

      // Embed in small batches to stay under Workers AI request limits.
      for (let i = 0; i < chunks.length; i += 10) {
        const batch = chunks.slice(i, i + 10);
        const embedResp = (await env.AI.run(EMBED_MODEL, {
          text: batch,
        })) as { data: number[][] };

        const vectors = batch.map((chunk, j) => ({
          id: `${hashId(url)}-${i + j}`,
          values: embedResp.data[j],
          metadata: {
            url,
            text: chunk,
          },
        }));

        await env.VECTORIZE.upsert(vectors);
        totalChunks += batch.length;
        urlChunks += batch.length;
      }

      if (urlChunks > 0) {
        succeeded.push(url);
      } else {
        // Shouldn't happen (chunkText always returns >=1 chunk for non-empty
        // text), but guard against silently reporting success with 0 chunks.
        failed.push({ url, reason: "produced 0 chunks" });
      }
    } catch (err) {
      console.error(`Failed to ingest ${url}:`, err);
      failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { totalChunks, succeeded, failed };
}

async function fetchAsPlainText(url: string, env: Env): Promise<string> {
  // Try a simple fetch first — faster and cheaper than spinning up a browser.
  const resp = await fetch(url, {
    headers: { "User-Agent": "cf-ai-docs-tutor-ingest/0.1" },
  });
  if (!resp.ok) return "";
  const html = await resp.text();
  return stripHtml(html);
}

function stripHtml(html: string): string {
  // Drop scripts/styles, then tags, then collapse whitespace. Good enough for docs pages.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

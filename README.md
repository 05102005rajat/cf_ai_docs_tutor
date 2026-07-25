# cf_ai_docs_tutor

A **RAG chat agent** that becomes an expert tutor for any developer documentation site. Point it at a set of docs URLs, it crawls them, stores embeddings in Cloudflare Vectorize, and answers questions with cited sources via Llama 3.3 on Workers AI.

Seeded out-of-the-box with Cloudflare's own developer docs (Agents, Workers AI, Vectorize, Durable Objects, Workflows, Browser Rendering) — so it's a meta-demo: **an AI tutor for the platform it's built on.**

Submitted for the Cloudflare Software Engineer Intern (Summer 2026) `cf_ai_` assignment.

## Live demo

**https://cf-ai-docs-tutor.05102005rajat.workers.dev**

## Architecture

| Required component | Implementation |
|---|---|
| **LLM** | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| **Workflow / coordination** | Durable Object (`DocsTutorAgent`) orchestrates the retrieve-then-generate loop per session; ingest pipeline runs batched embed → upsert |
| **User input** | Static Pages-style chat UI served via Worker Assets binding, posts JSON to the DO over HTTP |
| **Memory / state** | SQLite-backed Durable Object storage holds per-session chat history; Vectorize stores doc embeddings as long-term knowledge |

Other Cloudflare primitives used:
- **Workers AI** for both the embedding model (`bge-base-en-v1.5`) and the chat LLM
- **Vectorize** as the vector DB for retrieval
- **Browser Rendering** binding declared for richer crawls (the default ingest uses plain `fetch` + HTML stripping to stay within the free-tier quota)

```
                            ┌─ static assets (HTML/JS) ──► browser
 Worker (src/index.ts)  ────┤
                            └─ /chat ──► Durable Object (DocsTutorAgent)
                                           │
                                           ├─ 1. embed query  (Workers AI)
                                           ├─ 2. Vectorize.query()  ──► top-K chunks
                                           ├─ 3. build prompt with context + recent history (SQLite)
                                           └─ 4. Workers AI chat ──► response
```

## Project layout

```
cf_ai_docs_tutor/
├── src/
│   ├── index.ts     # Worker entry + routing + admin ingest endpoint
│   ├── agent.ts     # DocsTutorAgent Durable Object (RAG + chat history)
│   └── ingest.ts    # One-shot crawler + chunker + embedder + Vectorize upsert
├── public/
│   ├── index.html   # Chat UI
│   └── app.js       # Vanilla JS client (session ID in localStorage)
├── wrangler.jsonc   # Bindings for AI, Vectorize, Durable Object, Assets, Browser
├── package.json
├── tsconfig.json
├── README.md
└── PROMPTS.md       # AI prompts used during development
```

## Setup

### 1. Install dependencies

```bash
cd cf_ai_docs_tutor
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

### 3. Create the Vectorize index (one-time)

`bge-base-en-v1.5` outputs 768-dim vectors, cosine distance works well for docs.

```bash
npx wrangler vectorize create docs-tutor-index --dimensions=768 --metric=cosine
```

### 4. Deploy the Worker

```bash
npm run deploy
```

### 5. Seed the index

The first deploy exposes an admin endpoint at `POST /__ingest`, gated behind a shared-secret bearer token so it can't be triggered anonymously. Set the secret once:

```bash
npx wrangler secret put INGEST_TOKEN
# paste a random token when prompted
```

Then call it once to crawl the seed URLs in `src/ingest.ts` and populate Vectorize:

```bash
curl -X POST https://cf-ai-docs-tutor.<your-subdomain>.workers.dev/__ingest \
  -H "Authorization: Bearer <your INGEST_TOKEN>"
```

You should see `{"ok": true, "chunks_indexed": <N>}` where N is ~50–150 depending on seed size. Without `INGEST_TOKEN` set (or with a missing/wrong header), the endpoint returns `401 Unauthorized`.

### 6. Chat

Visit the deployed URL in your browser and start asking questions like:
- "How do I define a tool on an Agent?"
- "What's the difference between Durable Objects and Workflows?"
- "How do I query Vectorize from a Worker?"

## Local development

```bash
npm run dev
# visit http://localhost:8787
```

Note: Vectorize queries require remote bindings. Use `--remote` or deploy to test end-to-end RAG.

## Configuration

- **Seed URLs:** edit `SEED_URLS` in `src/ingest.ts`
- **Chunk size / overlap:** `CHUNK_SIZE` / `CHUNK_OVERLAP` in `src/ingest.ts`
- **Retrieval K:** `TOP_K` in `src/agent.ts`
- **Model:** `CHAT_MODEL` in `src/agent.ts`

## What's intentionally not included

- Authentication — sessions are keyed by a client-generated UUID in `localStorage`. Fine for a demo, don't ship to prod.
- Streaming responses — kept the response path simple JSON for clarity. Streaming via SSE is a one-step upgrade.
- Automatic re-ingestion — the ingest is manual. A natural next step is a `scheduled()` handler on a cron trigger to refresh the index weekly.

## Credits

Built by Rajat Choudhary (UCI CS, class of 2026) for the Cloudflare Software Engineer Intern (Summer 2026) application.

See `PROMPTS.md` for the AI-assisted coding prompts used during development.

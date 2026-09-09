# cf_ai_docs_tutor

A **retrieval-augmented generation (RAG) chat agent** that turns any developer documentation site into a citation-backed Q&A tutor. It crawls a set of seed URLs, embeds chunked text with Workers AI's `bge-base-en-v1.5` model into Cloudflare Vectorize, and answers questions with inline `[n]` source citations via Llama 3.3 70B — all served from a single Cloudflare Worker with a SQLite-backed Durable Object holding per-session chat history.

Seeded out-of-the-box with Cloudflare's own developer docs (Agents, Workers AI, Vectorize, Durable Objects, Workflows, Browser Rendering) — so it's a meta-demo: **an AI tutor for the platform it's built on.**

Originally built for the Cloudflare Software Engineer Intern (Summer 2026) `cf_ai_` take-home assignment; since hardened with a round of bug fixes (below).

| | |
|---|---|
| **Infrastructure** | 1 Worker, 3 bindings, 0 third-party services |
| **Retrieval** | top-5 Vectorize matches, 800-char chunks / 120 overlap |
| **Corpus** | 12 seed pages across 6 Cloudflare products |
| **Hardening** | 5 production-grade bugs found and fixed in one audit |

## Why I built it

Written for the Cloudflare SWE Intern take-home, but the question I actually
wanted answered was whether a complete RAG stack could run on Cloudflare's edge
with no external services at all: embeddings, vector store, generation and
session state all inside one Worker.

Seeding it with Cloudflare's own documentation was the test. If retrieval is
genuinely grounded, an agent built on Workers AI should be able to explain
Workers AI. If it is not, that shows up immediately as a wrong answer about the
platform I can verify myself.

## Live demo

**https://cf-ai-docs-tutor.05102005rajat.workers.dev**

## Highlights

- **Full RAG pipeline on Cloudflare's edge stack, no external services.** Embeddings (`@cf/baai/bge-base-en-v1.5`, 768-dim, cosine similarity) and chat completion (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) both run on Workers AI; vectors live in Vectorize; session state lives in a Durable Object's built-in SQLite storage — one Worker, three bindings, zero third-party infra.
- **Grounded, cited answers.** Every response is generated strictly from the top-5 Vectorize matches for the query, with inline `[1]`, `[2]`... citations that are cross-checked against what the model actually cited before being shown as sources — so a plain "hi" no longer drags 5 unrelated doc chunks into the UI.
- **Custom crawl → chunk → embed → upsert pipeline** (`src/ingest.ts`): fetches and HTML-strips 12 seed pages across 6 Cloudflare products, chunks at 800 characters with 120-character overlap, embeds in batches of 10, and reports per-URL success/failure with a reason instead of one opaque `ok` flag.
- **Hardened after an internal audit** that found and fixed five production-grade bugs in one pass: a crash on malformed/non-JSON chat POST bodies, a chat-history ordering bug in the SQLite query, an unauthenticated admin `/__ingest` endpoint (now gated behind a bearer-token secret), a UI mismatch that surfaced unrelated retrieved chunks as "sources," and a silently-swallowed per-page ingest failure that used to report `ok: true` on partial crawls.

## Architecture

| Required component | Implementation |
|---|---|
| **LLM** | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| **Workflow / coordination** | Durable Object (`DocsTutorAgent`) orchestrates the retrieve-then-generate loop per session; ingest pipeline runs batched embed → upsert |
| **User input** | Static Pages-style chat UI served via Worker Assets binding, posts JSON to the DO over HTTP |
| **Memory / state** | SQLite-backed Durable Object storage holds per-session chat history; Vectorize stores doc embeddings as long-term knowledge |

Other Cloudflare primitives used:
- **Workers AI** for both the embedding model (`bge-base-en-v1.5`) and the chat LLM
- **Vectorize** as the vector DB for retrieval (768-dim vectors, cosine metric, top-5 nearest-neighbor query per chat turn)
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

You should see `{"ok": true, "chunks_indexed": <N>, "pages_succeeded": <M>, "pages_failed": []}` where N is ~50–150 depending on seed size. `ok` is only `true` when every seed URL ingested; if any page was blocked, rate-limited, 404'd, or returned too little text, `ok` is `false` and `pages_failed` lists each failing URL with a reason — check that instead of assuming a full index just because the request didn't error. Without `INGEST_TOKEN` set (or with a missing/wrong header), the endpoint returns `401 Unauthorized`.

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

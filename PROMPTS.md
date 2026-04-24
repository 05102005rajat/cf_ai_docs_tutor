# PROMPTS.md

AI-assisted coding is encouraged per the Cloudflare assignment instructions. This file documents the prompts used during development of `cf_ai_docs_tutor`.

AI tool: **Claude (Sonnet/Opus in Claude Code)**.

---

## Architecture / scoping

> Help me scope a Cloudflare-hosted RAG chat agent that hits the four required components for the `cf_ai_` assignment (LLM, workflow/coordination, user input, memory/state). Use Llama 3.3 on Workers AI, Vectorize for retrieval, a Durable Object for per-session chat history, and a static Pages-style frontend. I want to ship in 2 days — what scope can I realistically cut without breaking the four-component rule?

Output: decided on a single-corpus RAG chat agent with a Durable Object holding SQLite-backed chat history, Vectorize holding doc embeddings, and a vanilla JS frontend (no React).

---

## Wrangler configuration

> Write a `wrangler.jsonc` for a Worker that binds: Workers AI, a Vectorize index called `docs-tutor-index`, a Durable Object class `DocsTutorAgent` with SQLite storage, a static `public/` assets binding, and the Browser Rendering binding. Use `compatibility_date: 2025-01-01` and `nodejs_compat` flag.

Output: `wrangler.jsonc` with the `new_sqlite_classes` migration and all bindings wired correctly.

---

## Durable Object with RAG

> Write a Durable Object class `DocsTutorAgent` in TypeScript. On POST `/chat`, it should:
>
> 1. Embed the user message using `@cf/baai/bge-base-en-v1.5`
> 2. Query Vectorize (`topK=5`, `returnMetadata="all"`)
> 3. Load the last 8 messages from SQLite history
> 4. Call `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with a system prompt that constrains it to the retrieved context and requires inline citations [1], [2]
> 5. Save both messages to SQLite
>
> Use the Workers `SqlStorage` API (not KV). Return the assistant reply as JSON.

Output: `src/agent.ts`. Iterated once to add a `GET /chat` endpoint for loading history into the UI on refresh.

---

## Ingest pipeline

> Write `src/ingest.ts` that exports `ingestDocs(env)`:
>
> - Iterate a hardcoded `SEED_URLS` list of Cloudflare docs pages
> - For each, `fetch` the HTML and strip scripts/styles/nav/footer/tags down to plain text
> - Chunk at 800 chars with 120 overlap
> - Batch embeddings in groups of 10 via Workers AI `bge-base-en-v1.5`
> - Upsert to Vectorize with metadata `{ url, text }`
> - Return total chunk count
>
> Use a simple hash function for vector IDs so re-ingestion is idempotent.

Output: `src/ingest.ts`. Kept `Browser Rendering` declared in wrangler but not used in the default path to stay on the free tier; plain `fetch` works for Cloudflare's docs since they're server-rendered.

---

## Frontend

> Write a minimal chat UI: single `public/index.html` + `public/app.js`, no framework. Dark theme, Cloudflare orange accent (#f6821f). Use `localStorage` for session ID. On load, GET `/chat?session=...` to hydrate history. On submit, POST to the same URL. Handle a "Thinking..." placeholder. No streaming needed for v1.

Output: `public/index.html` + `public/app.js`. ~120 lines total, works on mobile.

---

## README

> Write a README for this project that (a) explains the architecture via a table mapping each required component to its implementation, (b) gives step-by-step setup (`npm install`, `wrangler login`, `vectorize create`, deploy, `POST /__ingest`), (c) describes what's intentionally not included (auth, streaming, cron re-ingestion).

Output: `README.md`.

---

## Notes on AI assistance

- All architectural decisions (single-DO-per-session, SQLite for history, plain-fetch ingest to save quota) were mine; Claude accelerated the typing of boilerplate and caught a handful of Workers-AI binding typos.
- I rejected one of Claude's suggestions to add a full Workflows-based ingest pipeline with scheduled cron — too complex for v1, listed as future work in README instead.
- I wrote the system prompt in `agent.ts` by hand after Claude's first draft over-specified the citation format and the model started producing literal `[1]` tokens even when it had no context.

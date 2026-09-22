# AI News Hub

A personal AI-news aggregation dashboard. Live sources: Hacker News, arXiv, GitHub, and RSS (OpenAI, Hugging Face, Google DeepMind, Google Research, Mistral AI, NVIDIA Developer, Apple Machine Learning Research). See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the system fits together.

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` runs `next dev`, which picks its own port (printed in the terminal) and doesn't assume `3000` is free — don't assume it either, especially if other projects' dev servers might be running. Open whatever URL the terminal actually prints. If you're launching this project through `.claude/launch.json` (e.g. from an editor/preview tool), it's already pinned to `http://localhost:3100` there specifically so it never collides with an unrelated sibling project's dev server. The app works with **no database configured** — it falls back to live-fetch-only mode automatically.

### Optional AI features (enrichment, embeddings, Semantic search)

Entirely optional — the app is fully functional with zero AI configuration (Keyword search is the production default; Semantic search and AI enrichment simply report "not configured" and no-op everywhere). To enable them, copy `.env.example` to `.env.local` and fill in one of:

- `ANTHROPIC_API_KEY` (default provider if `AI_PROVIDER` is unset), or
- `AI_PROVIDER=openai` + `OPENAI_API_KEY` + `OPENAI_ENRICHMENT_MODEL`

for AI **enrichment** (summaries/topics), and separately `OPENAI_EMBEDDING_MODEL` (always alongside `OPENAI_API_KEY`, regardless of `AI_PROVIDER`) for **embeddings**/Semantic search — see `.env.example` for the full explanation of each. Nothing is inferred or defaulted; an unset variable means that feature is off.

Check what's configured, and preview what a real run would do, without spending anything:

```bash
npm run ai:status                        # provider/model configured? enrichment + HN-context cache stats
npm run ai:enrich -- --dry-run --limit 5  # 0 model calls, 0 writes — lists what WOULD be enriched
npm run ai:embed -- --dry-run --limit 5   # 0 embedding calls, 0 writes — same idea for embeddings
```

### Developing with AI credentials in `.env.local` but no AI calls

If `.env.local` has real `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` values (needed for semantic search / enrichment in normal use), plain `npm run dev` can still make a real, possibly billed request — e.g. just navigating to a Semantic-search URL. To develop or QA without that risk:

```bash
npm run dev:no-ai
```

This is `next dev` with one thing added: `AI_EGRESS_DISABLED=1`. It never touches, unsets, or prints `.env.local` — it just makes every OpenAI/Anthropic call this app can make (enrichment, embeddings, semantic search, the briefing-synthesis experiment) act exactly like "no provider configured," **even when valid credentials are present**. Semantic search falls back to keyword with its normal "unavailable" notice; nothing silently claims to have used AI. It's a development/operational safety control, not a way to manage or rotate credentials — real keys stay exactly where they are. `.claude/launch.json` has a matching `ai-news-hub-dev-no-ai` entry for browser-preview tooling. The same flag works for any of the `ai:*` CLI scripts (`AI_EGRESS_DISABLED=1 npm run ai:enrich -- --dry-run`, etc.) if you want to preview their output with zero chance of a real call.

## Database (optional, for persistence)

The app uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/) to persist ingested items, so previously-seen content survives a source outage or restart. It's entirely optional in development.

1. Copy `.env.example` to `.env.local` and set `DATABASE_URL` to any standard Postgres connection string:
   ```
   DATABASE_URL=postgres://user:password@localhost:5432/ai_news_hub
   ```
2. Apply migrations:
   ```bash
   npm run db:migrate
   ```
3. Run the app as usual (`npm run dev`). On each request, live-fetched items are upserted into the database, then read back for display — so re-ingesting the same story updates it in place rather than duplicating it.

**Local Postgres options** (any work — the app only ever reads `DATABASE_URL`, never a vendor-specific variable):
- An existing local Postgres install with the `vector` extension available (see below)
- A throwaway Docker container for testing, e.g.:
  ```bash
  docker run -d --name ai-news-hub-pg \
    -e POSTGRES_USER=devuser -e POSTGRES_PASSWORD=devpassword \
    -e POSTGRES_DB=ai_news_hub -p 127.0.0.1:5433:5432 pgvector/pgvector:pg16
  ```
- Any hosted Postgres with pgvector support (Neon, Supabase, and others enable it via `CREATE EXTENSION vector;`) — just paste its connection string into `DATABASE_URL`

**pgvector requirement (Step 17):** semantic search (`src/db/schema.ts`'s `feedItemEmbeddings` table) needs the PostgreSQL `vector` extension. The plain `postgres:16-alpine` image does **not** bundle it — use `pgvector/pgvector:pg16` instead (same Postgres 16, same `docker run` flags, just a different image tag; confirmed compatible with all existing migrations 0000–0006). Migration `0007_feed_item_embeddings.sql` runs `CREATE EXTENSION IF NOT EXISTS vector;` itself, so a fresh `npm run db:migrate` against the pgvector image is all that's needed — no separate manual step.
- **If you already have a `postgres:16-alpine` dev container with data you want to keep:** `pg_dump` it, stop/remove the old container, start a new one from `pgvector/pgvector:pg16` with the same credentials/port, `npm run db:migrate`, then `pg_restore`/`psql < dump.sql` your data back in.
- **Rollback:** if pgvector ever needs to be removed, drop the `feed_item_embeddings` table and its migration is otherwise additive — no other table or column was changed to add it. Reverting to a plain `postgres:16-alpine` image only requires that this table not exist (a fresh container from the old image simply won't have migration 0007 applied).

### Schema changes

```bash
npm run db:generate   # generate a new migration from src/db/schema.ts
npm run db:migrate    # apply pending migrations
```

Migration files are committed under `drizzle/`.

## Refreshing sources (explicit, never automatic)

Normal browsing never fetches from Hacker News/arXiv/GitHub/RSS — every page reads only what's already persisted. To pull in new content:

```bash
npm run sources:refresh
```

or click **Refresh sources** in the Sidebar (same underlying implementation, `src/lib/refreshService.ts`, either way — nothing runs on a schedule). Per-source outcome (last attempt, last success, item count, failure category) shows in the Sidebar's **Source Health** panel; a source counts as "Up to date" only if it succeeded within the last 6 hours, "Stale" if its last success is older than that, and "Never refreshed" if it has no successful attempt yet.

## Production build

```bash
npm run build
npm run start
```

Requires the same environment variables as development (`DATABASE_URL`, optionally `GITHUB_TOKEN`/the AI variables below) — `next build` runs with none of them configured just fine (every feature degrades to its documented no-op state), but `DATABASE_URL` is what makes the deployed app actually persist anything.

## Tests

```bash
npm test
```

Pure/unit tests always run. `*.integration.test.ts` files (real DB behavior — upsert/dedup, search, briefing reconstruction, reading state, etc.) run only when `DATABASE_URL` is actually present in `process.env` for the test runner, against a real Postgres instance — never against a mock, and never a real external network/AI call either way. Plain `npm test` from a shell that hasn't exported `.env.local`'s variables will silently skip these (not fail) — to run the complete DB-enabled suite:

```bash
set -a && source .env.local && set +a && npm test
```

(`source .env.local` alone, without `set -a`, sets shell-local variables that a child process like `vitest` never sees — `set -a` is what actually exports them.) If `.env.local` also has AI provider keys and you want a clean "nothing configured" baseline for that run, `unset OPENAI_API_KEY OPENAI_ENRICHMENT_MODEL OPENAI_EMBEDDING_MODEL` first.

## GitHub API (optional)

Set `GITHUB_TOKEN` in `.env.local` to raise GitHub's search rate limit. The app works fine without it (unauthenticated, lower limit).

## Daily workflow (v1)

- **Browsing**: open Home or `/briefing`, filter/search as needed, queue things worth reading later (the clock icon), mark read explicitly once you've read them, bookmark anything you want to keep around.
- **When content feels stale**: click Refresh sources (or `npm run sources:refresh`) — never automatic.
- **Developing/QA without any AI spend risk**: `npm run dev:no-ai`.
- **Intentionally testing AI features**: normal `npm run dev` with a provider configured in `.env.local` (see "Optional AI features" above).

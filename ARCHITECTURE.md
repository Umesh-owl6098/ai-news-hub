# AI News Hub — Architecture

A personal, single-user AI-news dashboard. This describes the system as it
exists today, not how it got here — see git history / prior step reports
for the design rationale behind individual decisions.

## Stack

- **Next.js (App Router)** — server components for every data-bearing
  page, a handful of small client components for the interactive leaves
  (search, filters, bookmark/queue/read toggles, date navigation).
- **PostgreSQL + Drizzle ORM** (`src/db/schema.ts`, `src/db/repository.ts`)
  — the persistence layer and single source of truth for everything
  except live source fetches. `pgvector` extension for embeddings.
- **Tailwind CSS** for styling.
- **Vitest** for tests (unit, pure-logic, and real-Postgres integration
  tests, gated on `DATABASE_URL`).

No auth, no accounts, no multi-tenancy — this is architecturally a
single-user app, not a multi-user product with auth stripped out.

## Ingestion and the explicit refresh model

Four source families: Hacker News, arXiv, GitHub, and RSS (currently 7
publishers — see `src/data/rssSources.ts`). Each has an adapter under
`src/lib/sources/` that fetches and normalizes into the common `FeedItem`
shape (`src/types/feed.ts`).

**Invariant: normal page rendering never ingests.** Every page (`/`,
`/briefing`, `/queue`, `/topics`, `/item/[id]`) reads *only* already-
persisted rows from `feed_items` via `src/db/repository.ts`. The only way
new content enters the database is the explicit refresh path:
`src/lib/refreshService.ts`'s `refreshAllSources()`, invoked either from
the Sidebar's "Refresh sources" button (`src/app/actions/refresh.ts`) or
the `npm run sources:refresh` CLI (`scripts/refresh-sources.ts`) — both
call the same implementation, never a duplicated one. A refresh upserts
by `sourceKey` (never delete-then-reinsert), so persisted state tied to a
feed item (bookmarks, queue, read state, embeddings) survives re-ingestion
untouched.

**Source health** (`source_health` table) records the outcome of every
refresh attempt per source — `last_attempted_at`, `last_succeeded_at`,
status, and a categorized error on failure. The Sidebar's Source Health
panel reads this to show "Up to date" / "Stale" / "Failed" /
"Never refreshed" per source; "Up to date" specifically means "succeeded
within the last 6 hours," never "definitely nothing new upstream."

## Search: Keyword (default) vs Semantic (optional)

`src/lib/search.ts` (`performSearch`) is the one entry point for both
modes, driven by URL state (`src/lib/searchState.ts`).

- **Keyword** (`src/db/repository.ts`'s `searchFeedItems`) is PostgreSQL
  full-text search (`tsvector`/`websearch_to_tsquery`) over a generated,
  weighted column on `feed_items` — this is the production default and
  requires no external service.
- **Semantic** (`src/lib/ai/semanticSearch.ts` → `vectorSearchFeedItems`)
  is pgvector cosine-distance search over `feed_item_embeddings`. It is
  entirely optional: with no embedding provider configured (or with AI
  egress disabled — see below), a Semantic request transparently falls
  back to Keyword for that one request and the UI says so ("Semantic
  search unavailable — showing keyword results.") rather than silently
  substituting different results. **AI is never required for ordinary
  browsing.**
- Publisher, source-type, time-range, and bookmarked-only filters apply
  identically to both modes via a shared filter object.

Embedding coverage can lag newly-ingested items until the embedding CLI
(`npm run ai:embed`) is run explicitly — there is no automatic backfill.

## Bookmarks, Reading Queue, and read state

Three independent, normalized single-user tables, each following the same
shape (`feed_item_id` referencing `feed_items.id` with `ON DELETE
RESTRICT`, so a future retention job can't silently cascade-delete
something the user chose to keep):

- `bookmarks` — "keep this."
- `reading_state` (`queuedAt`, `readAt`, both nullable) — "read this
  later" and "I've read this" are deliberately separate, independently
  settable/unsettable concepts, not inferred from each other.

**Invariant: none of these affect ranking, search relevance, Topics
aggregation, or Briefing selection.** They are read-only inputs to the UI
(icons/labels) and to `/queue`'s own listing — never a filter or boost
anywhere else.

## Item detail, related items, Topics

`/item/[id]` is a database-only detail view (no live source call) with a
bounded "related items" query (canonical-URL / normalized-title /
tag-overlap heuristics — see `getRelatedFeedItems`). `/topics` aggregates
existing `tags` and completed-enrichment topics over a rolling window
(`src/lib/topics.ts`, pure and DB-decoupled) — no separate topics table;
a topic is a live projection, recomputed on every request.

## Briefing: current and historical

`src/lib/briefing.ts`'s `buildBriefing` is a pure function: given a
candidate pool and a reference instant, it selects Top Stories / Research
/ Projects / News & Discussion by recency within a rolling 72h window,
with a per-source-type diversity cap in Top Stories. `/briefing` with no
`?date=` uses the real current instant. `/briefing?date=YYYY-MM-DD`
(`src/lib/briefingDate.ts`) reconstructs the *same* deterministic
selection anchored to `23:59:59.999 UTC` on that date — application
timezone is UTC throughout, one explicit constant, no per-user setting.

**Invariant: historical briefing is a reconstruction, not a snapshot.**
There is no `briefings`/`briefing_history` table and no scheduler —
`getFeedItemsForBriefing`/`getFeedItemsForTopics` bound their query by the
reference instant (both `publishedAt` and `createdAt`/first-ingestion
time, so a historical date reflects what this hub could actually have
shown *then*, not what today's fuller corpus retroactively knows).
Re-running the same historical query tomorrow returns the same rows.
Current source-health status is never shown on a historical date (it
would misrepresent history); queue/bookmark/read state shown alongside a
historical row is today's real state, not a claim about what it was back
then.

## AI enrichment / evaluation experiments

`src/lib/ai/` holds the enrichment pipeline (summary/topics/relevance via
`enrichmentService.ts`), the embedding pipeline (`embeddingService.ts`),
and a distinct, explicitly experimental **briefing-synthesis** path
(`briefingSynthesis*.ts`, Step 23) that is reachable only from its own
evaluation CLI (`npm run ai:briefing-evaluate`), never from `/briefing`
itself — kept as intentionally-retained evaluation infrastructure, not
production UI, because it did not demonstrate enough improvement over the
deterministic briefing to justify wiring it in. `evaluation/` and
`artifacts/ai-evaluation/` hold past evaluation run outputs.

## AI egress guard

`src/lib/ai/egress.ts`: `AI_EGRESS_DISABLED=1` makes every OpenAI/
Anthropic-calling code path (enrichment, embeddings, Semantic search, the
briefing-synthesis experiment) behave exactly like "no provider
configured," **even when valid credentials are present** — checked first,
before any credential inspection, in `getAiProvider()`/
`getEmbeddingProvider()`, with a second defense-in-depth check inside
each provider adapter's own network call. `npm run dev:no-ai` sets this
for local development/QA without spend risk. This is a development/
operational control, not credential management.

## Summary of architectural invariants

- Normal page GETs never ingest; ingestion only happens via the explicit
  refresh action/CLI.
- Keyword search is the production default; Semantic is optional and
  degrades honestly.
- AI (enrichment, embeddings, synthesis) is never required for ordinary
  browsing — every AI-touching feature has a safe, functional no-provider
  path.
- Bookmark/queue/read state never affects ranking, search, Topics, or
  Briefing selection.
- Historical Briefing is a deterministic reconstruction from persisted
  evidence, not a stored snapshot — no scheduler, no snapshot table.
- Single-user, no-auth architecture throughout.

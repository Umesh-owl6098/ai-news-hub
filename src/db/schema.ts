import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  real,
  timestamp,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Drizzle has no built-in tsvector column type; this models the shape for
// the query builder. The actual column is a PostgreSQL GENERATED ALWAYS AS
// ... STORED expression (see migration 0003) — Postgres keeps it in sync on
// every insert/update automatically, so no application code ever computes
// or recomputes a search document.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// Search field weights (PostgreSQL's four tiers: A > B > C > D). A title
// match should outrank a summary-only match; topical identifiers (tags,
// repo name, publisher) sit above free-text prose; author/owner/language
// are useful but the weakest signal.
//
// Uses `immutable_array_to_string` (created in migration 0003), not the
// built-in `array_to_string` — PostgreSQL requires a generated column's
// expression to be IMMUTABLE, but `array_to_string` is only marked STABLE
// (a general-purpose caution for polymorphic array functions, not because
// joining text[] with a fixed separator is actually non-deterministic), so
// the column fails to create without this trivial wrapper. Confirmed against
// a real PostgreSQL 16 instance before finalizing this migration.
//
// `repository_full_name` ("owner/repo") is run through `replace(..., '/', ' ')`
// first — Postgres's default text-search parser recognizes "word/word" as a
// single "file/path" token type and never splits it, so "owner/repo" would
// otherwise index as one opaque lexeme and never match a search for "repo"
// alone. Confirmed against a real PostgreSQL 16 instance.
const SEARCH_VECTOR_SQL = sql`
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(source_name, '') || ' ' || replace(coalesce(repository_full_name, ''), '/', ' ') || ' ' || coalesce(immutable_array_to_string(tags, ' '), '')), 'B') ||
  setweight(to_tsvector('english', coalesce(summary, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(immutable_array_to_string(authors, ' '), '') || ' ' || coalesce(owner, '') || ' ' || coalesce(language, '')), 'D')
`;

/**
 * One row per source-native item (an HN story, an arXiv paper, a GitHub
 * repo, an RSS article). Cross-source dedup (e.g. an RSS article that's
 * also an HN link) is intentionally NOT enforced here — that stays a
 * presentation/query concern for the combined "All" feed. `sourceKey` is
 * the stable external identity (e.g. "hn:123456", "rss:openai:<guid>")
 * that upserts key off of; `id` is just an internal surrogate key.
 */
export const feedItems = pgTable(
  "feed_items",
  {
    id: serial("id").primaryKey(),

    // Stable external identity — matches FeedItem.id from the app layer.
    // `text`, not `varchar`, because RSS keys embed a full canonical URL
    // with no practical length ceiling; truncating the unique-conflict
    // target could silently collide two distinct long URLs.
    sourceKey: text("source_key").notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceId: varchar("source_id", { length: 128 }),
    sourceName: varchar("source_name", { length: 128 }).notNull(),

    title: text("title").notNull(),
    summary: text("summary").notNull(),

    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    normalizedTitle: text("normalized_title").notNull(),

    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),

    discussionUrl: text("discussion_url"),
    pdfUrl: text("pdf_url"),

    // Hacker News upvotes/comments — actively rendered by FeedCard, so
    // these earn typed columns rather than living only in a JSON blob.
    score: integer("score"),
    commentCount: integer("comment_count"),

    // Small, stable, already-typed arrays — not worth a join table or a
    // catch-all JSON blob.
    authors: text("authors").array(),
    tags: text("tags").array(),

    // GitHub-only fields. Left null for every other source rather than
    // splitting into a separate per-source table (see milestone notes).
    repositoryFullName: varchar("repository_full_name", { length: 256 }),
    owner: varchar("owner", { length: 128 }),
    language: varchar("language", { length: 64 }),
    stars: integer("stars"),
    forks: integer("forks"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    // Generated column — Postgres computes and stores this automatically.
    // Never written to directly from application code.
    searchVector: tsvector("search_vector").generatedAlwaysAs(SEARCH_VECTOR_SQL),
  },
  (table) => [
    uniqueIndex("feed_items_source_key_idx").on(table.sourceKey),
    index("feed_items_published_at_idx").on(table.publishedAt),
    index("feed_items_canonical_url_idx").on(table.canonicalUrl),
    index("feed_items_normalized_title_idx").on(table.normalizedTitle),
    index("feed_items_source_type_idx").on(table.sourceType),
    index("feed_items_search_vector_idx").using("gin", table.searchVector),
  ]
);

export type FeedItemRow = typeof feedItems.$inferSelect;
export type NewFeedItemRow = typeof feedItems.$inferInsert;

/**
 * One row per bookmarked feed item. Deliberately a separate table rather
 * than a `bookmarked` boolean on `feed_items` — this is a single-user app
 * (no `users` table), but keeping bookmarks normalized means the schema
 * doesn't need to change shape if that ever stops being true, and keeps
 * "things the owner chose to keep" cleanly separable from ingested content.
 *
 * `onDelete: "restrict"` is intentional: bookmarks exist specifically to
 * preserve items the owner cares about. A future feed-retention/pruning
 * job must not be able to silently cascade-delete a bookmarked article out
 * from under the user — it should have to explicitly unbookmark first (or
 * exclude bookmarked rows from pruning). Cascading here would defeat the
 * entire purpose of bookmarking.
 */
export const bookmarks = pgTable(
  "bookmarks",
  {
    id: serial("id").primaryKey(),
    feedItemId: integer("feed_item_id")
      .notNull()
      .references(() => feedItems.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One bookmark per feed item — also the conflict target for idempotent add.
    uniqueIndex("bookmarks_feed_item_id_idx").on(table.feedItemId),
  ]
);

export type BookmarkRow = typeof bookmarks.$inferSelect;
export type NewBookmarkRow = typeof bookmarks.$inferInsert;

/**
 * Step 26 — one row per feed item that is queued and/or read, holding two
 * INDEPENDENT nullable timestamps rather than two separate tables (or
 * booleans): `queuedAt` set means "in the reading queue," `readAt` set
 * means "read," and either can be set, cleared, or both, without touching
 * the other. A row with `queuedAt: null` and `readAt` set is a real,
 * supported state (read without ever being queued). Once BOTH columns are
 * null the row is deleted entirely rather than left as an empty husk, so
 * this table only ever holds items with some active reading state — same
 * "delete when inactive" discipline as bookmarks.
 *
 * Mirrors `bookmarks`' FK policy exactly: `onDelete: "restrict"` so a
 * future pruning job can't silently cascade-delete a queued/read item out
 * from under the user — unqueue/mark-unread first. Independent from
 * `bookmarks` in every direction (see repository.ts) — a bookmark, queue,
 * and read state can be set in any combination for the same item.
 */
export const readingState = pgTable(
  "reading_state",
  {
    id: serial("id").primaryKey(),
    feedItemId: integer("feed_item_id")
      .notNull()
      .references(() => feedItems.id, { onDelete: "restrict" }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    // One row per feed item — also the conflict target for idempotent upserts.
    uniqueIndex("reading_state_feed_item_id_idx").on(table.feedItemId),
  ]
);

export type ReadingStateRow = typeof readingState.$inferSelect;
export type NewReadingStateRow = typeof readingState.$inferInsert;

// --- AI enrichment ----------------------------------------------------
//
// One row per feed item holding AI-generated metadata (summary, topic
// tags, a relevance estimate). Deliberately a separate table rather than
// columns on `feed_items`: enrichment is optional, regenerable, provider-
// dependent metadata layered on top of an article, not part of the
// article's own identity — and every row here can be dropped/rebuilt
// without touching a single ingested fact. `onDelete: "cascade"` (unlike
// bookmarks' "restrict") is intentional: an enrichment has no meaning or
// owner-driven purpose once its source article is gone.
//
// Bounded, explicit sets for `status`/`errorCode` are enforced with real
// CHECK constraints in the migration (see drizzle/0004_ai_enrichments.sql)
// — not just documented here — so a bug can't silently write an
// unrecognized state into the database.
export const ENRICHMENT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number];

export const PROVIDER_ERROR_CODES = [
  "not_configured",
  "rate_limited",
  "timeout",
  "invalid_output",
  "provider_error",
] as const;
export type PersistedProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export const articleEnrichments = pgTable(
  "article_enrichments",
  {
    id: serial("id").primaryKey(),
    feedItemId: integer("feed_item_id")
      .notNull()
      .references(() => feedItems.id, { onDelete: "cascade" }),

    provider: varchar("provider", { length: 32 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 32 }).notNull(),

    // sha256 hex of the exact fields (+ prompt version) fed to the model —
    // see src/lib/ai/hash.ts. Lets a re-enrichment attempt skip the model
    // call entirely when nothing relevant has changed since the last
    // completed run.
    inputHash: varchar("input_hash", { length: 64 }).notNull(),

    // Populated once a run reaches "completed"; left as-is (stale-but-not
    // wiped) if a later re-enrichment attempt fails, so a transient
    // failure never regresses a card from "has AI summary" to "has none."
    summary: text("summary"),
    topics: text("topics").array(),
    relevanceScore: real("relevance_score"),

    status: varchar("status", { length: 16 }).notNull().default("pending"),
    errorCode: varchar("error_code", { length: 32 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one *current* enrichment row per item — re-enrichment
    // updates this row in place rather than accumulating history.
    uniqueIndex("article_enrichments_feed_item_id_idx").on(table.feedItemId),
    index("article_enrichments_status_idx").on(table.status),
  ]
);

export type ArticleEnrichmentRow = typeof articleEnrichments.$inferSelect;
export type NewArticleEnrichmentRow = typeof articleEnrichments.$inferInsert;

// --- HN discussion context cache (Step 14) ------------------------------
//
// Caches the bounded, normalized Hacker News discussion text fetched via
// the official Firebase API (see src/lib/ai/hnContext.ts) so that
// enriching the same story repeatedly doesn't re-fetch comments on every
// run, and so a routine refresh that finds byte-identical content never
// looks like a content change to the enrichment cache. One row per feed
// item (unique constraint) — a refresh overwrites `normalizedContext` and
// `fetchedAt` in place, it never accumulates history.
//
// `onDelete: "cascade"`, matching `article_enrichments`: this cache has no
// meaning once its source article is gone. Deliberately NOT a TTL/expiry
// column in the schema — staleness is a service-layer policy decision
// (src/lib/ai/hnContextCache.ts), not a database concern, and MUST NOT be
// folded into the enrichment input hash (see hash.ts) — only
// `normalizedContext` may ever influence whether re-enrichment is
// triggered, never `fetchedAt`.
//
// `status` (Step 16): a row is written for TWO distinct outcomes, not
// just one. `has_context` means Hacker News gave us usable text/comments
// (`normalizedContext` populated). `no_context` means Hacker News
// responded successfully but the story genuinely has nothing usable —
// a real, confirmed result, deliberately persisted so it's
// distinguishable from "never attempted" and from a transient network
// failure (which must NEVER write a row here at all — see
// hnContextCache.ts). This is a real column, not an empty-string or
// timestamp sentinel, specifically so a bug can't confuse "checked, and
// there's nothing" with "haven't checked yet" or "couldn't check."
export const HN_CONTEXT_CACHE_STATUSES = ["has_context", "no_context"] as const;
export type HnContextCacheStatus = (typeof HN_CONTEXT_CACHE_STATUSES)[number];

export const hnDiscussionContext = pgTable(
  "hn_discussion_context",
  {
    id: serial("id").primaryKey(),
    feedItemId: integer("feed_item_id")
      .notNull()
      .references(() => feedItems.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 16 }).notNull().default("has_context"),
    // NULL exactly when status = 'no_context' — enforced by a real CHECK
    // constraint in the migration, not just convention.
    normalizedContext: text("normalized_context"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("hn_discussion_context_feed_item_id_idx").on(table.feedItemId)]
);

export type HnDiscussionContextRow = typeof hnDiscussionContext.$inferSelect;
export type NewHnDiscussionContextRow = typeof hnDiscussionContext.$inferInsert;

// --- Semantic embeddings (Step 17) --------------------------------------
//
// Deliberately an UNCONSTRAINED `vector` column (no fixed dimension in the
// column type), not Drizzle's typed `vector({ dimensions })` builder —
// Step 17 explicitly defers choosing an embedding model/provider to the
// user, and a pgvector column's dimension is fixed at creation time, so a
// TypeScript-level fixed dimension would silently bake in a model choice
// this schema is not supposed to make. `dimensions` is instead a real,
// explicit per-row column, cross-checked against the actual stored vector
// length by a CHECK constraint in the migration (`vector_dims(embedding)
// = dimensions`) — the database enforces consistency even though the
// column itself stays dimension-agnostic. Confirmed against a real
// PostgreSQL 16 + pgvector 0.8 instance before finalizing this migration.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .filter((part) => part.length > 0)
      .map(Number);
  },
});

/**
 * One CURRENT embedding per (feed item, provider, model, embedding schema
 * version) — a refresh overwrites in place (see `upsertFeedItemEmbedding`
 * in repository.ts), it never accumulates history. Multiple rows for the
 * same feed item are only possible across a provider/model/version change
 * (e.g. comparing two embedding models side by side, or a deliberate
 * re-embed after `toSemanticDocument`'s shape changes) — never as
 * duplicates of the same one. `inputHash` is the sole cache/invalidation
 * boundary (see `src/lib/ai/embeddingHash.ts`): it folds in the normalized
 * semantic document, the model identifier, and the embedding schema
 * version, and deliberately never a timestamp — mirroring the same
 * discipline already established for enrichment (`hash.ts`) and the HN
 * context cache. `onDelete: "cascade"`, matching every other per-feed-item
 * side table in this schema.
 */
export const feedItemEmbeddings = pgTable(
  "feed_item_embeddings",
  {
    id: serial("id").primaryKey(),
    feedItemId: integer("feed_item_id")
      .notNull()
      .references(() => feedItems.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    embeddingVersion: integer("embedding_version").notNull(),
    inputHash: varchar("input_hash", { length: 64 }).notNull(),
    // Real column, not derived solely from `embedding` at read time — see
    // the CHECK constraint note above for why both exist.
    dimensions: integer("dimensions").notNull(),
    embedding: vector("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("feed_item_embeddings_item_model_version_idx").on(
      table.feedItemId,
      table.provider,
      table.model,
      table.embeddingVersion
    ),
  ]
);

export type FeedItemEmbeddingRow = typeof feedItemEmbeddings.$inferSelect;
export type NewFeedItemEmbeddingRow = typeof feedItemEmbeddings.$inferInsert;

// --- Source health (Step 21) ---------------------------------------------
//
// One compact, CURRENT-STATE row per external source identity — not a run
// history table. For a single-user personal project, "when did this last
// succeed, and what happened on the last attempt" answers every question
// this milestone actually asks; a full history table would be logging
// infrastructure this app doesn't need yet. A refresh overwrites the
// relevant columns in place, exactly like `article_enrichments`/
// `hn_discussion_context`'s existing "one current row, upserted" pattern.
//
// `sourceKey` is a stable, human-assigned identity distinct from
// `feed_items.source_key` — e.g. "hackernews", "arxiv", "github",
// "rss:openai" — chosen so each configured RSS publisher gets its own row
// (never collapsed into one generic "news" row, which would hide which
// publisher actually failed).
export const SOURCE_HEALTH_STATUSES = ["never_run", "success", "failed"] as const;
export type SourceHealthStatus = (typeof SOURCE_HEALTH_STATUSES)[number];

// Small, bounded categories — enough to distinguish "worth retrying soon"
// (rate_limited, timeout, network_error) from "something is structurally
// wrong" (http_error, parse_error, database_error) without attempting to
// parse arbitrary upstream error text into a large taxonomy.
export const SOURCE_HEALTH_ERROR_CATEGORIES = [
  "rate_limited",
  "timeout",
  "network_error",
  "http_error",
  "parse_error",
  "database_error",
  "unknown",
] as const;
export type SourceHealthErrorCategory = (typeof SOURCE_HEALTH_ERROR_CATEGORIES)[number];

export const sourceHealth = pgTable(
  "source_health",
  {
    id: serial("id").primaryKey(),
    sourceKey: varchar("source_key", { length: 64 }).notNull(),
    sourceLabel: varchar("source_label", { length: 128 }).notNull(),

    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    // Deliberately never overwritten by a failed attempt — see
    // `recordSourceHealthFailure` in repository.ts. A failure updates
    // `lastAttemptedAt`/`lastStatus`/the error columns, but this column
    // and `lastSuccessItemCount` are untouched, so "last known good state"
    // is never lost to a transient failure.
    lastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
    lastSuccessItemCount: integer("last_success_item_count"),

    lastStatus: varchar("last_status", { length: 16 }).notNull().default("never_run"),
    // Both null exactly when lastStatus != 'failed' — enforced by a CHECK
    // constraint in the migration, not just convention (mirroring
    // article_enrichments' errorCode discipline).
    lastErrorCategory: varchar("last_error_category", { length: 32 }),
    // Short, sanitized, safe-to-display text only — never a raw response
    // body, header, or stack trace. See refreshService.ts's error
    // sanitization for what's allowed to reach this column.
    lastErrorMessage: varchar("last_error_message", { length: 512 }),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("source_health_source_key_idx").on(table.sourceKey)]
);

export type SourceHealthRow = typeof sourceHealth.$inferSelect;
export type NewSourceHealthRow = typeof sourceHealth.$inferInsert;

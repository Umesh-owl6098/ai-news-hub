import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import {
  feedItems,
  bookmarks,
  readingState,
  articleEnrichments,
  hnDiscussionContext,
  feedItemEmbeddings,
  sourceHealth,
  type NewFeedItemRow,
  type FeedItemRow,
  type EnrichmentStatus,
  type PersistedProviderErrorCode,
  type HnContextCacheStatus,
  type SourceHealthRow,
  type SourceHealthStatus,
  type SourceHealthErrorCategory,
} from "@/db/schema";
import { FeedItem, SourceType } from "@/types/feed";
import { canonicalizeUrl } from "@/lib/url";
import { normalizeTitle } from "@/lib/title";
import { dedupeFeedItems } from "@/lib/dedupe";

/**
 * Thrown by repository functions on a genuine database failure (connection
 * error, query error) — never for "database not configured," which callers
 * handle by treating the repository as empty. The message is always safe
 * to show a user; raw driver/SQL errors are logged server-side only.
 */
export class DatabaseError extends Error {}

function logDbError(operation: string, error: unknown): void {
  // Deliberately terse: postgres.js errors embed the full failed query and
  // its bound parameters in `.message`, which is safe (no credentials —
  // DATABASE_URL itself is never part of a query) but needlessly verbose
  // for a log line, and Next's dev server mirrors console.error into the
  // browser console for convenience. Keep only the error name here.
  const label = error instanceof Error ? error.constructor.name : typeof error;
  console.error(`[db] ${operation} failed (${label})`);
}

// --- FeedItem <-> DB row conversion (centralized, single direction each way) ---

export function feedItemToRow(item: FeedItem): NewFeedItemRow {
  return {
    sourceKey: item.id,
    sourceType: item.sourceType,
    sourceId: item.sourceId ?? null,
    sourceName: item.sourceName,
    title: item.title,
    summary: item.description,
    url: item.url,
    canonicalUrl: canonicalizeUrl(item.url),
    normalizedTitle: normalizeTitle(item.title),
    publishedAt: new Date(item.publishedAt),
    discussionUrl: item.discussionUrl ?? null,
    pdfUrl: item.pdfUrl ?? null,
    score: item.score,
    commentCount: item.commentCount,
    authors: item.authors && item.authors.length > 0 ? item.authors : null,
    tags: item.tags.length > 0 ? item.tags : null,
    repositoryFullName: item.repositoryFullName ?? null,
    owner: item.owner ?? null,
    language: item.language ?? null,
    stars: item.stars ?? null,
    forks: item.forks ?? null,
  };
}

export function rowToFeedItem(row: FeedItemRow): FeedItem {
  return {
    id: row.sourceKey,
    dbId: row.id,
    sourceType: row.sourceType as SourceType,
    sourceName: row.sourceName,
    sourceId: row.sourceId ?? undefined,
    title: row.title,
    description: row.summary,
    publishedAt: row.publishedAt.toISOString(),
    tags: row.tags ?? [],
    score: row.score ?? 0,
    commentCount: row.commentCount ?? 0,
    url: row.url,
    discussionUrl: row.discussionUrl ?? undefined,
    pdfUrl: row.pdfUrl ?? undefined,
    authors: row.authors && row.authors.length > 0 ? row.authors : undefined,
    repositoryFullName: row.repositoryFullName ?? undefined,
    owner: row.owner ?? undefined,
    language: row.language ?? undefined,
    stars: row.stars ?? undefined,
    forks: row.forks ?? undefined,
  };
}

/**
 * Upserts a batch of normalized items in one round trip, keyed on the
 * stable `sourceKey` (e.g. "hn:123456"). Re-ingesting the same item updates
 * mutable fields (title/summary/stars/forks/etc.) and refreshes
 * `lastSeenAt` rather than creating a duplicate row.
 *
 * No-ops silently when the database isn't configured — persistence is an
 * enhancement, not a hard requirement for the app to function.
 */
export async function upsertFeedItems(items: FeedItem[]): Promise<void> {
  const db = getDb();
  if (!db || items.length === 0) return;

  const rows = items.map(feedItemToRow);

  try {
    await db
      .insert(feedItems)
      .values(rows)
      .onConflictDoUpdate({
        target: feedItems.sourceKey,
        set: {
          sourceType: sql`excluded.source_type`,
          sourceId: sql`excluded.source_id`,
          sourceName: sql`excluded.source_name`,
          title: sql`excluded.title`,
          summary: sql`excluded.summary`,
          url: sql`excluded.url`,
          canonicalUrl: sql`excluded.canonical_url`,
          normalizedTitle: sql`excluded.normalized_title`,
          publishedAt: sql`excluded.published_at`,
          discussionUrl: sql`excluded.discussion_url`,
          pdfUrl: sql`excluded.pdf_url`,
          score: sql`excluded.score`,
          commentCount: sql`excluded.comment_count`,
          authors: sql`excluded.authors`,
          tags: sql`excluded.tags`,
          repositoryFullName: sql`excluded.repository_full_name`,
          owner: sql`excluded.owner`,
          language: sql`excluded.language`,
          stars: sql`excluded.stars`,
          forks: sql`excluded.forks`,
          updatedAt: sql`now()`,
          lastSeenAt: sql`now()`,
        },
      });
  } catch (error) {
    logDbError("upsertFeedItems", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

export interface GetRecentFeedItemsOptions {
  sourceType?: SourceType;
  limit?: number;
}

const DEFAULT_RECENT_LIMIT = 60;

/**
 * Returns recent persisted items, most recent first (published_at desc,
 * id desc as a deterministic tie-breaker). Returns an empty array — never
 * throws — when the database isn't configured.
 */
export async function getRecentFeedItems(options: GetRecentFeedItemsOptions = {}): Promise<FeedItem[]> {
  const db = getDb();
  if (!db) return [];

  const { sourceType, limit = DEFAULT_RECENT_LIMIT } = options;

  try {
    const rows = await db
      .select()
      .from(feedItems)
      .where(sourceType ? eq(feedItems.sourceType, sourceType) : undefined)
      .orderBy(desc(feedItems.publishedAt), desc(feedItems.id))
      .limit(limit);

    return rows.map(rowToFeedItem);
  } catch (error) {
    logDbError("getRecentFeedItems", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

/**
 * Same as getRecentFeedItems, scoped to one source-family + specific
 * publisher (e.g. sourceType "news", sourceId "openai"). Not currently
 * used by any tab (all RSS publishers share the News tab), but kept small
 * and available now that the schema supports it cleanly.
 */
export async function getRecentFeedItemsBySource(
  sourceType: SourceType,
  sourceId: string,
  limit: number = DEFAULT_RECENT_LIMIT
): Promise<FeedItem[]> {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = await db
      .select()
      .from(feedItems)
      .where(and(eq(feedItems.sourceType, sourceType), eq(feedItems.sourceId, sourceId)))
      .orderBy(desc(feedItems.publishedAt), desc(feedItems.id))
      .limit(limit);

    return rows.map(rowToFeedItem);
  } catch (error) {
    logDbError("getRecentFeedItemsBySource", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

/**
 * Single-item lookup by internal DB id, for the Step 19 `/item/[id]` detail
 * route. Unlike bookmarks (which key everything off `sourceKey` and never
 * surface this id), the detail route deliberately uses the numeric primary
 * key as its stable, source-agnostic identity — an RSS `sourceKey` embeds a
 * full external URL (with `/`), which is unsuited to a single dynamic route
 * segment, while every other source's key is a plain scalar. `null` for a
 * missing/deleted item — the route calls Next's `notFound()` on that, never
 * a 500.
 */
export async function getFeedItemById(id: number): Promise<FeedItem | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const [row] = await db.select().from(feedItems).where(eq(feedItems.id, id)).limit(1);
    return row ? rowToFeedItem(row) : null;
  } catch (error) {
    logDbError("getFeedItemById", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

export interface TopicSourceRow {
  feedItemId: number;
  item: FeedItem;
  tags: string[];
  enrichmentTopics: string[] | null;
}

// Generous safety bound, not a real limit at current corpus size (~160
// items total) — prevents an unbounded scan if the corpus grows far larger
// before this query gets revisited.
const MAX_TOPICS_SOURCE_POOL = 5000;

/**
 * Raw material for Step 20's Topics aggregation (`src/lib/topics.ts`,
 * which does all the actual grouping/normalization in-process — this
 * function's only job is a single, bounded, correctly-filtered fetch).
 * Filters to `publishedAt >= now() - sinceDays` (uses the existing
 * `feed_items_published_at_idx`) and to items that have SOME topic signal
 * at all — non-empty `tags` or a completed enrichment's `topics` — so
 * items with neither (most Hacker News items, many untagged RSS items)
 * are correctly excluded up front rather than silently producing an empty
 * topic list entry downstream.
 */
export async function getFeedItemsForTopics(
  options: { sinceDays: number; referenceInstant?: Date }
): Promise<TopicSourceRow[]> {
  const db = getDb();
  if (!db) return [];

  // Step 28: defaults to the real current instant, preserving /topics'
  // existing "now"-anchored behavior exactly when the caller doesn't pass
  // one — only the briefing page's historical view supplies a past
  // instant, so Active Topics on a historical briefing reflects topic
  // activity as of that date, not today's.
  const referenceInstant = options.referenceInstant ?? new Date();
  const lowerBound = new Date(referenceInstant.getTime() - options.sinceDays * 24 * 60 * 60 * 1000);

  try {
    const rows = await db
      .select({
        item: feedItems,
        enrichmentTopics: articleEnrichments.topics,
      })
      .from(feedItems)
      .leftJoin(
        articleEnrichments,
        and(eq(articleEnrichments.feedItemId, feedItems.id), eq(articleEnrichments.status, "completed"))
      )
      .where(
        and(
          gte(feedItems.publishedAt, lowerBound),
          lte(feedItems.publishedAt, referenceInstant),
          // Same first-ingestion reasoning as getFeedItemsForBriefing above
          // — a no-op bound for the live "now" case (nothing is ingested
          // in the future), load-bearing only for a historical instant.
          lte(feedItems.createdAt, referenceInstant),
          or(
            sql`${feedItems.tags} is not null and array_length(${feedItems.tags}, 1) > 0`,
            sql`${articleEnrichments.topics} is not null and array_length(${articleEnrichments.topics}, 1) > 0`
          )
        )
      )
      .orderBy(desc(feedItems.publishedAt), desc(feedItems.id))
      .limit(MAX_TOPICS_SOURCE_POOL);

    return rows.map((row) => ({
      feedItemId: row.item.id,
      item: rowToFeedItem(row.item),
      tags: row.item.tags ?? [],
      enrichmentTopics: row.enrichmentTopics && row.enrichmentTopics.length > 0 ? row.enrichmentTopics : null,
    }));
  } catch (error) {
    logDbError("getFeedItemsForTopics", error);
    // Topics are a discovery aid, never load-bearing — degrade to "no
    // topics computable right now" rather than a broken page.
    return [];
  }
}

// Generous safety bound for the briefing candidate pool — NOT the
// editorial window (see BRIEFING_WINDOW_HOURS in src/lib/briefing.ts,
// currently 72h). This fetches a superset wide enough that the pure,
// unit-testable `buildBriefing` can apply the exact eligible-window cutoff
// itself (with an injectable `now` for tests), while the DB query stays a
// single bounded read — never the whole corpus (Step 22 §13).
const BRIEFING_CANDIDATE_LOOKBACK_DAYS = 14;
const MAX_BRIEFING_CANDIDATE_POOL = 1000;

/**
 * Raw candidate pool for the Step 22 daily briefing — a single bounded,
 * read-only query (no ingestion, no AI/embedding call). Deliberately
 * returns plain `FeedItem[]`, not pre-selected: all editorial selection
 * (recency window, cross-source diversity, section assignment) happens in
 * `buildBriefing` (src/lib/briefing.ts), which is pure and independently
 * testable without a database.
 *
 * Step 28: `referenceInstant` (defaults to the real current instant, i.e.
 * unchanged "today" behavior) anchors BOTH bounds explicitly at the query
 * level, rather than relying on Postgres's own `now()` — required for
 * historical `/briefing?date=` reconstruction to be deterministic
 * (re-running the same historical query tomorrow must return the same
 * rows). Also bounds `createdAt` (first-ingestion time — confirmed by
 * audit to survive `upsertFeedItems`' conflict-update, which never
 * touches that column) to `<= referenceInstant`: a historical briefing
 * for Sep 20 represents what this hub could actually have shown on Sep
 * 20, not what today's fuller corpus retroactively knows was published
 * around then. An item published before Sep 20 but not ingested until
 * Sep 22 is correctly excluded from the Sep 20 reconstruction.
 */
export async function getFeedItemsForBriefing(
  options: { referenceInstant?: Date; lookbackDays?: number } = {}
): Promise<FeedItem[]> {
  const db = getDb();
  if (!db) return [];

  const referenceInstant = options.referenceInstant ?? new Date();
  const lookbackDays = options.lookbackDays ?? BRIEFING_CANDIDATE_LOOKBACK_DAYS;
  const lowerBound = new Date(referenceInstant.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  try {
    const rows = await db
      .select()
      .from(feedItems)
      .where(
        and(
          gte(feedItems.publishedAt, lowerBound),
          lte(feedItems.publishedAt, referenceInstant),
          lte(feedItems.createdAt, referenceInstant)
        )
      )
      .orderBy(desc(feedItems.publishedAt), desc(feedItems.id))
      .limit(MAX_BRIEFING_CANDIDATE_POOL);

    return rows.map(rowToFeedItem);
  } catch (error) {
    logDbError("getFeedItemsForBriefing", error);
    // The briefing is a discovery aid, never load-bearing — degrade to
    // "nothing to show right now" rather than a broken page.
    return [];
  }
}

// --- Bookmarks -------------------------------------------------------------
//
// Bookmarks reference `feed_items` by internal DB id, never expose that id
// to the browser, and never duplicate article metadata — the bookmark row
// is just "this feed item, saved." The client only ever deals in the same
// stable `sourceKey` (== FeedItem.id) it already uses everywhere else.

async function getFeedItemDbId(sourceKey: string): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select({ id: feedItems.id })
    .from(feedItems)
    .where(eq(feedItems.sourceKey, sourceKey))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Bookmarks the feed item identified by `sourceKey`. Idempotent: bookmarking
 * an already-bookmarked item is a no-op (relies on the DB unique constraint,
 * not just app-level checking, so concurrent calls can't create duplicates).
 * Throws DatabaseError if the item doesn't exist yet or the DB is down —
 * callers must not report success when nothing was actually saved.
 */
export async function addBookmark(sourceKey: string): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("Persistent bookmarks are unavailable right now.");

  try {
    const feedItemId = await getFeedItemDbId(sourceKey);
    if (feedItemId === null) {
      throw new DatabaseError("Couldn't save bookmark. Try again.");
    }
    await db.insert(bookmarks).values({ feedItemId }).onConflictDoNothing({ target: bookmarks.feedItemId });
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    logDbError("addBookmark", error);
    throw new DatabaseError("Couldn't save bookmark. Try again.");
  }
}

/**
 * Removes the bookmark for `sourceKey`, if any. Idempotent: removing a
 * bookmark that doesn't exist (or an unknown sourceKey) is a silent no-op,
 * not an error — the end state the caller wants ("not bookmarked") already
 * holds.
 */
export async function removeBookmark(sourceKey: string): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("Persistent bookmarks are unavailable right now.");

  try {
    const feedItemId = await getFeedItemDbId(sourceKey);
    if (feedItemId === null) return;
    await db.delete(bookmarks).where(eq(bookmarks.feedItemId, feedItemId));
  } catch (error) {
    logDbError("removeBookmark", error);
    throw new DatabaseError("Couldn't remove bookmark. Try again.");
  }
}

/**
 * All currently-bookmarked source keys, in one bounded query — used to
 * initialize client-side bookmark state for every card at once instead of
 * querying per-card.
 */
export async function getBookmarkedSourceKeys(): Promise<string[]> {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = await db
      .select({ sourceKey: feedItems.sourceKey })
      .from(bookmarks)
      .innerJoin(feedItems, eq(bookmarks.feedItemId, feedItems.id));
    return rows.map((row) => row.sourceKey);
  } catch (error) {
    logDbError("getBookmarkedSourceKeys", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

const DEFAULT_BOOKMARKS_LIMIT = 200;

/**
 * Bookmarked items with full source-specific metadata intact, most
 * recently bookmarked first. One joined query — no per-item follow-up
 * lookups.
 */
export async function getBookmarkedFeedItems(limit: number = DEFAULT_BOOKMARKS_LIMIT): Promise<FeedItem[]> {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = await db
      .select({ item: feedItems })
      .from(bookmarks)
      .innerJoin(feedItems, eq(bookmarks.feedItemId, feedItems.id))
      .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
      .limit(limit);

    return rows.map((row) => rowToFeedItem(row.item));
  } catch (error) {
    logDbError("getBookmarkedFeedItems", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

// --- Reading queue & read state (Step 26) -----------------------------
//
// One row per feed item with active queue and/or read state, referenced by
// internal DB id exactly like bookmarks — see schema.ts's `readingState`
// doc comment for why this is one table with two independent nullable
// timestamps rather than two tables or booleans. Every mutation here is
// idempotent and every read is a single bounded query; nothing in this
// section touches any live source fetch or AI/embedding provider, and
// every MUTATION below is reachable only from the Server Actions in
// `src/app/actions/readingState.ts` — a page render may call the read
// functions, but never addToQueue/removeFromQueue/markRead/markUnread.

/**
 * Adds `sourceKey` to the reading queue. Idempotent: a repeat call
 * preserves the ORIGINAL `queuedAt` (via `coalesce` against the existing
 * row) rather than bumping it to now — a duplicate "queue" click must not
 * jump the item to the top of /queue's most-recently-queued ordering.
 * Read state, if any, is untouched. Throws if the item doesn't exist yet
 * or the DB is down.
 */
export async function addToQueue(sourceKey: string): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("The reading queue is unavailable right now.");

  try {
    const feedItemId = await getFeedItemDbId(sourceKey);
    if (feedItemId === null) {
      throw new DatabaseError("Couldn't queue this item. Try again.");
    }
    await db
      .insert(readingState)
      .values({ feedItemId, queuedAt: new Date() })
      .onConflictDoUpdate({
        target: readingState.feedItemId,
        set: { queuedAt: sql`coalesce(${readingState.queuedAt}, now())` },
      });
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    logDbError("addToQueue", error);
    throw new DatabaseError("Couldn't queue this item. Try again.");
  }
}

/**
 * Removes `sourceKey` from the reading queue, if queued. Idempotent — a
 * repeat call, or one for an unqueued/unknown item, is a silent no-op.
 * Read state is untouched (§3: queue/read are independent); the row is
 * only deleted once BOTH `queuedAt` and `readAt` are unset, matching
 * bookmarks' "delete when inactive" discipline.
 */
export async function removeFromQueue(sourceKey: string): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("The reading queue is unavailable right now.");

  try {
    const feedItemId = await getFeedItemDbId(sourceKey);
    if (feedItemId === null) return;
    await db.update(readingState).set({ queuedAt: null }).where(eq(readingState.feedItemId, feedItemId));
    await db
      .delete(readingState)
      .where(
        and(eq(readingState.feedItemId, feedItemId), isNull(readingState.queuedAt), isNull(readingState.readAt))
      );
  } catch (error) {
    logDbError("removeFromQueue", error);
    throw new DatabaseError("Couldn't remove this item from the queue. Try again.");
  }
}

/**
 * Marks `sourceKey` read. Idempotent (preserves the original `readAt` on a
 * repeat call, same `coalesce` pattern as `addToQueue`). Queue state, if
 * any, is untouched — marking an item read does not remove it from the
 * queue (§3). Supports an item that's read but never queued: this simply
 * inserts a row with `queuedAt: null`.
 */
export async function markRead(sourceKey: string): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("Read state is unavailable right now.");

  try {
    const feedItemId = await getFeedItemDbId(sourceKey);
    if (feedItemId === null) {
      throw new DatabaseError("Couldn't mark this item read. Try again.");
    }
    await db
      .insert(readingState)
      .values({ feedItemId, readAt: new Date() })
      .onConflictDoUpdate({
        target: readingState.feedItemId,
        set: { readAt: sql`coalesce(${readingState.readAt}, now())` },
      });
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    logDbError("markRead", error);
    throw new DatabaseError("Couldn't mark this item read. Try again.");
  }
}

/**
 * Marks `sourceKey` unread. Idempotent, and a no-op for an unread/unknown
 * item. Queue state is untouched; the row is deleted only once both
 * `queuedAt` and `readAt` are unset (same discipline as `removeFromQueue`).
 */
export async function markUnread(sourceKey: string): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("Read state is unavailable right now.");

  try {
    const feedItemId = await getFeedItemDbId(sourceKey);
    if (feedItemId === null) return;
    await db.update(readingState).set({ readAt: null }).where(eq(readingState.feedItemId, feedItemId));
    await db
      .delete(readingState)
      .where(
        and(eq(readingState.feedItemId, feedItemId), isNull(readingState.queuedAt), isNull(readingState.readAt))
      );
  } catch (error) {
    logDbError("markUnread", error);
    throw new DatabaseError("Couldn't mark this item unread. Try again.");
  }
}

export interface ReadingStateKeys {
  queuedKeys: string[];
  readKeys: string[];
}

/**
 * Every currently-queued and currently-read source key, in one bounded
 * query — used to initialize client-side queue/read state for every card
 * at once (mirrors `getBookmarkedSourceKeys`), and to check a single
 * item's state on the detail page without a second query.
 */
export async function getReadingStateKeys(): Promise<ReadingStateKeys> {
  const db = getDb();
  if (!db) return { queuedKeys: [], readKeys: [] };

  try {
    const rows = await db
      .select({ sourceKey: feedItems.sourceKey, queuedAt: readingState.queuedAt, readAt: readingState.readAt })
      .from(readingState)
      .innerJoin(feedItems, eq(readingState.feedItemId, feedItems.id));

    const queuedKeys: string[] = [];
    const readKeys: string[] = [];
    for (const row of rows) {
      if (row.queuedAt !== null) queuedKeys.push(row.sourceKey);
      if (row.readAt !== null) readKeys.push(row.sourceKey);
    }
    return { queuedKeys, readKeys };
  } catch (error) {
    logDbError("getReadingStateKeys", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

/**
 * Count of queued-but-unread items — the Sidebar's optional nav badge.
 * One cheap `COUNT` query, read once per Home page render (never polled).
 */
export async function getUnreadQueuedCount(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  try {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(readingState)
      .where(and(isNotNull(readingState.queuedAt), isNull(readingState.readAt)));
    return row?.count ?? 0;
  } catch (error) {
    logDbError("getUnreadQueuedCount", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

export interface QueueItemRow {
  item: FeedItem;
  queuedAt: Date;
  read: boolean;
  bookmarked: boolean;
}

const DEFAULT_QUEUE_LIMIT = 200;

/**
 * Queued items (queuedAt set) with read and bookmark state joined in,
 * most-recently-queued first — one bounded query, no per-row follow-up
 * lookups (§16). An item that's read but was never queued does not appear
 * here: /queue is the queue, not a general read-state log.
 */
export async function getQueueItems(limit: number = DEFAULT_QUEUE_LIMIT): Promise<QueueItemRow[]> {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = await db
      .select({
        item: feedItems,
        queuedAt: readingState.queuedAt,
        readAt: readingState.readAt,
        bookmarkId: bookmarks.id,
      })
      .from(readingState)
      .innerJoin(feedItems, eq(readingState.feedItemId, feedItems.id))
      .leftJoin(bookmarks, eq(bookmarks.feedItemId, readingState.feedItemId))
      .where(isNotNull(readingState.queuedAt))
      .orderBy(desc(readingState.queuedAt), desc(readingState.id))
      .limit(limit);

    return rows.map((row) => ({
      item: rowToFeedItem(row.item),
      queuedAt: row.queuedAt!,
      read: row.readAt !== null,
      bookmarked: row.bookmarkId !== null,
    }));
  } catch (error) {
    logDbError("getQueueItems", error);
    throw new DatabaseError("Stored feed data is temporarily unavailable.");
  }
}

// --- Search ------------------------------------------------------------
//
// Lexical search against the persisted store using PostgreSQL's built-in
// full-text search (websearch_to_tsquery + a generated, GIN-indexed
// tsvector column — see schema.ts). No external search service, no
// embeddings, no application-level scoring loop.

export type SearchSortMode = "relevance" | "newest";

export interface SearchFeedItemsOptions {
  /** Free-text query. Undefined/empty means "no text filter" (browse mode). */
  query?: string;
  sourceType?: SourceType;
  /** Publisher within a sourceType, e.g. sourceId "openai" under "news". */
  sourceId?: string;
  /** Only rows published within the last N days. Undefined means "any time." */
  sinceDays?: number;
  bookmarkedOnly?: boolean;
  /** Defaults to "relevance" when `query` is set, else "newest". */
  sort?: SearchSortMode;
  limit?: number;
  offset?: number;
}

export interface SearchFeedItemsResult {
  items: FeedItem[];
  /** Total matching rows (before pagination), for "N results" and page count. */
  total: number;
}

const DEFAULT_SEARCH_LIMIT = 24;
const MAX_SEARCH_LIMIT = 50;
// Defense in depth — src/lib/searchState.ts already bounds/validates this
// before it ever reaches here, but a repository function should never trust
// a caller not to change later.
const MAX_QUERY_LENGTH = 300;

/**
 * Searches persisted feed items. Text relevance uses PostgreSQL's
 * `websearch_to_tsquery`, which is deliberately forgiving of malformed
 * input (unmatched quotes, stray operators) — it degrades to a reasonable
 * interpretation instead of raising a syntax error, so arbitrary user text
 * can never produce a SQL/tsquery error. The query text is always passed as
 * a bound parameter, never concatenated into SQL.
 */
export async function searchFeedItems(options: SearchFeedItemsOptions = {}): Promise<SearchFeedItemsResult> {
  const db = getDb();
  if (!db) throw new DatabaseError("Stored search is temporarily unavailable.");

  const rawQuery = options.query?.trim().slice(0, MAX_QUERY_LENGTH);
  const query = rawQuery && rawQuery.length > 0 ? rawQuery : undefined;
  const sort: SearchSortMode = options.sort ?? (query ? "relevance" : "newest");
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  // websearch_to_tsquery never throws on malformed input (unlike
  // to_tsquery), and is bound as a parameter, never string-concatenated.
  const tsQuery: SQL | undefined = query ? sql`websearch_to_tsquery('english', ${query})` : undefined;
  const rankExpr = tsQuery ? sql<number>`ts_rank_cd(${feedItems.searchVector}, ${tsQuery})` : sql<number>`0`;

  const conditions: SQL[] = [];
  if (tsQuery) conditions.push(sql`${feedItems.searchVector} @@ ${tsQuery}`);
  if (options.sourceType) conditions.push(eq(feedItems.sourceType, options.sourceType));
  if (options.sourceId) conditions.push(eq(feedItems.sourceId, options.sourceId));
  if (options.sinceDays) {
    conditions.push(gte(feedItems.publishedAt, sql`now() - make_interval(days => ${options.sinceDays})`));
  }
  if (options.bookmarkedOnly) conditions.push(sql`${bookmarks.id} is not null`);

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orderBy =
    sort === "relevance" && tsQuery
      ? [desc(rankExpr), desc(feedItems.publishedAt), desc(feedItems.id)]
      : [desc(feedItems.publishedAt), desc(feedItems.id)];

  try {
    const [rows, [{ count }]] = await Promise.all([
      db
        .select({ item: feedItems, rank: rankExpr })
        .from(feedItems)
        // Left join, not inner — bookmarkedOnly is expressed as a WHERE
        // condition on this join so the same FROM clause serves every
        // combination of filters without branching query shapes.
        .leftJoin(bookmarks, eq(bookmarks.feedItemId, feedItems.id))
        .where(whereClause)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(feedItems)
        .leftJoin(bookmarks, eq(bookmarks.feedItemId, feedItems.id))
        .where(whereClause),
    ]);

    const items = rows.map((row) => rowToFeedItem(row.item));
    // Cross-source dedup (original publisher over an HN link to the same
    // article, etc.) only applies to the unscoped "All" search — a
    // source-specific search (e.g. the Hacker News tab) must still show
    // its own submission. `total` intentionally reflects pre-dedup rows,
    // same trade-off the existing All-feed tab already accepts.
    const deduped = options.sourceType || options.bookmarkedOnly ? items : dedupeFeedItems(items);

    return { items: deduped, total: count };
  } catch (error) {
    logDbError("searchFeedItems", error);
    throw new DatabaseError("Stored search is temporarily unavailable.");
  }
}

// --- AI enrichment -----------------------------------------------------
//
// Persistence for the AI enrichment pipeline (src/lib/ai/enrichmentService.ts).
// This module never calls a model — it only stores/loads what the service
// layer computed. Reads used by page rendering (getEnrichmentsBySourceKeys)
// are one bulk join, never a per-card query.

export interface FeedItemForEnrichment {
  feedItemId: number;
  title: string;
  sourceName: string;
  summary: string;
  authors: string[] | null;
  tags: string[] | null;
  repositoryFullName: string | null;
  owner: string | null;
  language: string | null;
}

/**
 * Loads exactly the fields the enrichment prompt needs, by the same
 * stable `sourceKey` used everywhere else. Returns null if the item
 * doesn't exist (caller's responsibility — enrichment is only ever run
 * against items we've already ingested).
 */
export async function getFeedItemForEnrichment(sourceKey: string): Promise<FeedItemForEnrichment | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({
      feedItemId: feedItems.id,
      title: feedItems.title,
      sourceName: feedItems.sourceName,
      summary: feedItems.summary,
      authors: feedItems.authors,
      tags: feedItems.tags,
      repositoryFullName: feedItems.repositoryFullName,
      owner: feedItems.owner,
      language: feedItems.language,
    })
    .from(feedItems)
    .where(eq(feedItems.sourceKey, sourceKey))
    .limit(1);

  return row ?? null;
}

export interface EnrichmentRecord {
  feedItemId: number;
  status: EnrichmentStatus;
  inputHash: string;
  summary: string | null;
  topics: string[] | null;
  relevanceScore: number | null;
  errorCode: PersistedProviderErrorCode | null;
}

function rowToEnrichmentRecord(row: typeof articleEnrichments.$inferSelect): EnrichmentRecord {
  return {
    feedItemId: row.feedItemId,
    status: row.status as EnrichmentStatus,
    inputHash: row.inputHash,
    summary: row.summary,
    topics: row.topics,
    relevanceScore: row.relevanceScore,
    errorCode: row.errorCode as PersistedProviderErrorCode | null,
  };
}

export async function getEnrichmentByFeedItemId(feedItemId: number): Promise<EnrichmentRecord | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select()
    .from(articleEnrichments)
    .where(eq(articleEnrichments.feedItemId, feedItemId))
    .limit(1);

  return row ? rowToEnrichmentRecord(row) : null;
}

export interface MarkEnrichmentProcessingInput {
  feedItemId: number;
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
}

/**
 * Creates or updates the enrichment row for `feedItemId` to `status:
 * "processing"`, upserting on the unique `feedItemId` constraint —
 * exactly one current row per item, never a growing history. Deliberately
 * leaves any previously-completed `summary`/`topics`/`relevanceScore` in
 * place: if this attempt fails, a card that already had an AI summary
 * keeps showing it rather than flashing to "no enrichment."
 */
export async function markEnrichmentProcessing(input: MarkEnrichmentProcessingInput): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("Enrichment storage is temporarily unavailable.");

  try {
    await db
      .insert(articleEnrichments)
      .values({
        feedItemId: input.feedItemId,
        provider: input.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        inputHash: input.inputHash,
        status: "processing",
        errorCode: null,
      })
      .onConflictDoUpdate({
        target: articleEnrichments.feedItemId,
        set: {
          provider: input.provider,
          model: input.model,
          promptVersion: input.promptVersion,
          inputHash: input.inputHash,
          status: "processing",
          errorCode: null,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    logDbError("markEnrichmentProcessing", error);
    throw new DatabaseError("Enrichment storage is temporarily unavailable.");
  }
}

export interface MarkEnrichmentCompletedInput {
  feedItemId: number;
  summary: string;
  topics: string[];
  relevanceScore: number;
}

export async function markEnrichmentCompleted(input: MarkEnrichmentCompletedInput): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("Enrichment storage is temporarily unavailable.");

  try {
    await db
      .update(articleEnrichments)
      .set({
        status: "completed",
        summary: input.summary,
        topics: input.topics,
        relevanceScore: input.relevanceScore,
        errorCode: null,
        updatedAt: sql`now()`,
      })
      .where(eq(articleEnrichments.feedItemId, input.feedItemId));
  } catch (error) {
    logDbError("markEnrichmentCompleted", error);
    throw new DatabaseError("Enrichment storage is temporarily unavailable.");
  }
}

/**
 * Transitions a row to "failed" with a safe, bounded error code. Called
 * from the enrichment service's catch block for every failure path — the
 * one invariant this pipeline guarantees is that a row can never be left
 * stuck on "processing" after an ordinary (non-crash) failure.
 */
export async function markEnrichmentFailed(
  feedItemId: number,
  errorCode: PersistedProviderErrorCode
): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("Enrichment storage is temporarily unavailable.");

  try {
    await db
      .update(articleEnrichments)
      .set({ status: "failed", errorCode, updatedAt: sql`now()` })
      .where(eq(articleEnrichments.feedItemId, feedItemId));
  } catch (error) {
    logDbError("markEnrichmentFailed", error);
    throw new DatabaseError("Enrichment storage is temporarily unavailable.");
  }
}

export interface EnrichmentCandidate {
  sourceKey: string;
  feedItemId: number;
  title: string;
  sourceName: string;
  summary: string;
  authors: string[] | null;
  tags: string[] | null;
  repositoryFullName: string | null;
  owner: string | null;
  language: string | null;
  existingInputHash: string | null;
  existingStatus: EnrichmentStatus | null;
}

/**
 * A bounded pool of candidate items, ordered most recent first.
 * `poolSize` is intentionally larger than the caller's actual batch
 * limit: the caller still has to re-check each candidate's input hash
 * in-process (content may have changed since a prior *completed* run,
 * which this query alone can't detect), so a modest over-fetch avoids a
 * second round trip while staying bounded — never a full table scan.
 *
 * By default (`includeCompleted: false`) excludes items that already
 * have a *completed* enrichment row — the normal batch-enrichment path
 * only wants items missing one, never enriched, previously failed, or
 * stuck mid-run. `includeCompleted: true` returns every recent item
 * regardless of status, for callers that need the full picture (a
 * `--dry-run` preview showing "already current, would skip," or a
 * `--force` re-enrichment pass that intentionally reconsiders current
 * items too).
 */
export async function getEnrichmentCandidates(options: {
  poolSize: number;
  sourceType?: SourceType;
  includeCompleted?: boolean;
  /** Restricts candidates to `sourceKey LIKE '<prefix>%'` — see
   * `getEmbeddingCandidates`'s identical option. Test-only in practice;
   * no production call site sets it. */
  sourceKeyPrefix?: string;
}): Promise<EnrichmentCandidate[]> {
  const db = getDb();
  if (!db) return [];

  const conditions: SQL[] = [];
  if (!options.includeCompleted) {
    conditions.push(or(isNull(articleEnrichments.id), ne(articleEnrichments.status, "completed"))!);
  }
  if (options.sourceType) conditions.push(eq(feedItems.sourceType, options.sourceType));
  if (options.sourceKeyPrefix) conditions.push(like(feedItems.sourceKey, `${options.sourceKeyPrefix}%`));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      sourceKey: feedItems.sourceKey,
      feedItemId: feedItems.id,
      title: feedItems.title,
      sourceName: feedItems.sourceName,
      summary: feedItems.summary,
      authors: feedItems.authors,
      tags: feedItems.tags,
      repositoryFullName: feedItems.repositoryFullName,
      owner: feedItems.owner,
      language: feedItems.language,
      existingInputHash: articleEnrichments.inputHash,
      existingStatus: articleEnrichments.status,
    })
    .from(feedItems)
    .leftJoin(articleEnrichments, eq(articleEnrichments.feedItemId, feedItems.id))
    .where(whereClause)
    .orderBy(desc(feedItems.publishedAt), desc(feedItems.id))
    .limit(options.poolSize);

  return rows.map((row) => ({
    ...row,
    existingInputHash: row.existingInputHash ?? null,
    existingStatus: (row.existingStatus as EnrichmentStatus | null) ?? null,
  }));
}

/**
 * Step 16 maintenance pool: completed Hacker News items whose discussion
 * context is either missing entirely (no cache row — pre-Step-14 items, or
 * a prior attempt that hit an outage and therefore never persisted a row)
 * or older than `ttlMs`. This is deliberately a SEPARATE query from
 * `getEnrichmentCandidates` rather than a flag on it: normal candidates are
 * selected by "does this item need enrichment at all," while maintenance
 * candidates are selected by "is this item's cached context due for a
 * refresh," and an item can be a maintenance candidate while its
 * enrichment is otherwise perfectly current (existingInputHash still
 * matches — the point is to let `enrichFeedItem` re-check, not to force a
 * new hash). Bounded by `poolSize` and ordered the same way as normal
 * candidates so the two pools compose predictably.
 *
 * Filters on `sourceKey LIKE 'hn:%'`, not `sourceType = 'hackernews'`:
 * the HN context cache is gated entirely by sourceKey shape (see
 * `isHnSourceKey` in hnContextCache.ts, which every real HN item satisfies
 * — the ingestion adapter always writes `hn:${item.id}`), and matching
 * that same gate here means this pool can never select an item that
 * `resolveHnSourceContext` would immediately no-op on anyway.
 */
export async function getStaleHnMaintenanceCandidates(options: {
  poolSize: number;
  ttlMs: number;
  /** Further restricts to `sourceKey LIKE '<prefix>%'`, on top of the
   * existing `hn:%` gate below — see `getEnrichmentCandidates`'s identical
   * option. Test-only in practice; no production call site sets it. */
  sourceKeyPrefix?: string;
}): Promise<EnrichmentCandidate[]> {
  const db = getDb();
  if (!db) return [];

  const ttlSeconds = Math.floor(options.ttlMs / 1000);

  const conditions: SQL[] = [
    like(feedItems.sourceKey, "hn:%"),
    eq(articleEnrichments.status, "completed"),
    or(
      isNull(hnDiscussionContext.id),
      lt(hnDiscussionContext.fetchedAt, sql`now() - make_interval(secs => ${ttlSeconds})`)
    )!,
  ];
  if (options.sourceKeyPrefix) conditions.push(like(feedItems.sourceKey, `${options.sourceKeyPrefix}%`));

  const rows = await db
    .select({
      sourceKey: feedItems.sourceKey,
      feedItemId: feedItems.id,
      title: feedItems.title,
      sourceName: feedItems.sourceName,
      summary: feedItems.summary,
      authors: feedItems.authors,
      tags: feedItems.tags,
      repositoryFullName: feedItems.repositoryFullName,
      owner: feedItems.owner,
      language: feedItems.language,
      existingInputHash: articleEnrichments.inputHash,
      existingStatus: articleEnrichments.status,
    })
    .from(feedItems)
    .innerJoin(articleEnrichments, eq(articleEnrichments.feedItemId, feedItems.id))
    .leftJoin(hnDiscussionContext, eq(hnDiscussionContext.feedItemId, feedItems.id))
    .where(and(...conditions))
    .orderBy(desc(feedItems.publishedAt), desc(feedItems.id))
    .limit(options.poolSize);

  return rows.map((row) => ({
    ...row,
    existingInputHash: row.existingInputHash ?? null,
    existingStatus: (row.existingStatus as EnrichmentStatus | null) ?? null,
  }));
}

/**
 * Aggregate counts by status, for lightweight CLI observability (see
 * `npm run ai:status`) — one grouped query, never a per-row scan from
 * application code.
 */
export async function getEnrichmentStatusCounts(): Promise<Record<EnrichmentStatus, number>> {
  const counts: Record<EnrichmentStatus, number> = { pending: 0, processing: 0, completed: 0, failed: 0 };
  const db = getDb();
  if (!db) return counts;

  const rows = await db
    .select({ status: articleEnrichments.status, count: sql<number>`count(*)::int` })
    .from(articleEnrichments)
    .groupBy(articleEnrichments.status);

  for (const row of rows) {
    const status = row.status as EnrichmentStatus;
    if (status in counts) counts[status] = row.count;
  }
  return counts;
}

/**
 * Completed-enrichment metadata for a set of items, keyed by the stable
 * `sourceKey` the client/UI already uses — one bulk join, called once per
 * page render (never once per card). Deliberately omits `relevanceScore`:
 * that field is internal ranking metadata for future evaluation, not
 * something the UI should ever receive (see milestone notes) — keeping it
 * out of this return type means it structurally cannot leak into a
 * client-visible prop.
 */
export async function getEnrichmentsBySourceKeys(
  sourceKeys: string[]
): Promise<Map<string, { summary: string; topics: string[] }>> {
  const db = getDb();
  if (!db || sourceKeys.length === 0) return new Map();

  const rows = await db
    .select({
      sourceKey: feedItems.sourceKey,
      summary: articleEnrichments.summary,
      topics: articleEnrichments.topics,
    })
    .from(articleEnrichments)
    .innerJoin(feedItems, eq(articleEnrichments.feedItemId, feedItems.id))
    .where(and(eq(articleEnrichments.status, "completed"), inArray(feedItems.sourceKey, sourceKeys)));

  const map = new Map<string, { summary: string; topics: string[] }>();
  for (const row of rows) {
    if (row.summary && row.topics && row.topics.length > 0) {
      map.set(row.sourceKey, { summary: row.summary, topics: row.topics });
    }
  }
  return map;
}

// --- HN discussion context cache (Step 14, status column added Step 16) --

export type HnContextCacheRecord =
  | { status: Extract<HnContextCacheStatus, "has_context">; normalizedContext: string; fetchedAt: Date }
  | { status: Extract<HnContextCacheStatus, "no_context">; normalizedContext: null; fetchedAt: Date };

/**
 * Read-only lookup — never fetches from Hacker News, never writes. Used
 * both by the real enrichment flow (to decide freshness) and by the
 * dry-run/eligibility preview (which must never make a network call).
 */
export async function getHnContextCache(feedItemId: number): Promise<HnContextCacheRecord | null> {
  const db = getDb();
  if (!db) return null;

  const [row] = await db
    .select({
      status: hnDiscussionContext.status,
      normalizedContext: hnDiscussionContext.normalizedContext,
      fetchedAt: hnDiscussionContext.fetchedAt,
    })
    .from(hnDiscussionContext)
    .where(eq(hnDiscussionContext.feedItemId, feedItemId))
    .limit(1);

  if (!row) return null;
  // The CHECK constraint in the migration guarantees normalizedContext is
  // non-null exactly when status is 'has_context' — this cast just tells
  // TypeScript what the database already enforces.
  return row as HnContextCacheRecord;
}

/**
 * Upserts the cached context for one feed item, refreshing `fetchedAt` to
 * now — one row per item, a refresh overwrites in place rather than
 * accumulating history. Callers must never derive the enrichment input
 * hash from `fetchedAt`; only `normalizedContext` may affect it.
 *
 * `no_context` is a real, confirmed result (Hacker News responded but had
 * nothing usable) and is written here just like `has_context` — the one
 * result that must NEVER reach this function is a network failure/outage,
 * which callers handle by leaving the existing cache row (if any) alone.
 */
export async function upsertHnContextCache(
  feedItemId: number,
  result: { status: "has_context"; normalizedContext: string } | { status: "no_context" }
): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("HN context cache storage is temporarily unavailable.");

  const normalizedContext = result.status === "has_context" ? result.normalizedContext : null;

  try {
    await db
      .insert(hnDiscussionContext)
      .values({ feedItemId, status: result.status, normalizedContext })
      .onConflictDoUpdate({
        target: hnDiscussionContext.feedItemId,
        set: { status: result.status, normalizedContext, fetchedAt: sql`now()` },
      });
  } catch (error) {
    logDbError("upsertHnContextCache", error);
    throw new DatabaseError("HN context cache storage is temporarily unavailable.");
  }
}

export interface HnContextCacheStats {
  /** Every Hacker News feed item, regardless of enrichment status — the
   * four counts below always sum to this. */
  eligibleHnFeedItems: number;
  /** status = 'has_context' and fetched within the TTL. */
  freshContextRows: number;
  /** status = 'has_context' but older than the TTL — due for a refresh. */
  staleContextRows: number;
  /** status = 'no_context' — Hacker News responded but had nothing usable,
   * a confirmed result (any freshness; re-checked after the TTL like any
   * other stale row). */
  noUsableContextRows: number;
  /** No cache row at all — never successfully attempted (pre-Step-14 item,
   * or every attempt so far hit a network outage, which never persists a
   * row). Distinct from `noUsableContextRows`, which means HN answered. */
  neverAttemptedRows: number;
  mostRecentRefresh: Date | null;
}

/**
 * Aggregate, secret-free health snapshot for `npm run ai:status` — one
 * bulk query (never per-row), never returns comment/story text. The left
 * join is 1:1 (unique index on feed_item_id), so this never fans out.
 */
export async function getHnContextCacheStats(
  ttlSeconds: number,
  options: {
    /** Further restricts to `sourceKey LIKE '<prefix>%'`, on top of the
     * existing `hn:%` gate below — lets an integration test compute this
     * global-by-design stat scoped to only its own fixtures instead of the
     * whole corpus. Test-only in practice; the real `ai:status` CLI never
     * sets it, so its output is unaffected. */
    sourceKeyPrefix?: string;
  } = {}
): Promise<HnContextCacheStats> {
  const empty: HnContextCacheStats = {
    eligibleHnFeedItems: 0,
    freshContextRows: 0,
    staleContextRows: 0,
    noUsableContextRows: 0,
    neverAttemptedRows: 0,
    mostRecentRefresh: null,
  };
  const db = getDb();
  if (!db) return empty;

  const conditions: SQL[] = [
    // Same gate as getStaleHnMaintenanceCandidates: sourceKey shape, not
    // the sourceType column, since that's what actually determines
    // whether the HN context cache applies to an item at all.
    like(feedItems.sourceKey, "hn:%"),
  ];
  if (options.sourceKeyPrefix) conditions.push(like(feedItems.sourceKey, `${options.sourceKeyPrefix}%`));

  const [stats] = await db
    .select({
      eligibleHnFeedItems: sql<number>`count(*)::int`,
      freshContextRows: sql<number>`count(*) filter (where ${hnDiscussionContext.status} = 'has_context' and ${hnDiscussionContext.fetchedAt} > now() - make_interval(secs => ${ttlSeconds}))::int`,
      staleContextRows: sql<number>`count(*) filter (where ${hnDiscussionContext.status} = 'has_context' and ${hnDiscussionContext.fetchedAt} <= now() - make_interval(secs => ${ttlSeconds}))::int`,
      noUsableContextRows: sql<number>`count(*) filter (where ${hnDiscussionContext.status} = 'no_context')::int`,
      neverAttemptedRows: sql<number>`count(*) filter (where ${hnDiscussionContext.id} is null)::int`,
      mostRecentRefresh: sql<Date | null>`max(${hnDiscussionContext.fetchedAt})`,
    })
    .from(feedItems)
    .leftJoin(hnDiscussionContext, eq(hnDiscussionContext.feedItemId, feedItems.id))
    .where(and(...conditions));

  if (!stats) return empty;
  return {
    ...stats,
    // The postgres.js driver doesn't always parse a raw `max(timestamptz)`
    // aggregate expression into a Date the way it does a plain column
    // select — normalize here so every caller gets a real Date, never a
    // string it has to guess about.
    mostRecentRefresh: stats.mostRecentRefresh ? new Date(stats.mostRecentRefresh) : null,
  };
}

// --- Semantic embeddings (Step 17) --------------------------------------

export interface EmbeddingCandidate {
  feedItemId: number;
  sourceKey: string;
  title: string;
  summary: string;
  sourceType: SourceType;
  sourceName: string;
  tags: string[] | null;
  authors: string[] | null;
  repositoryFullName: string | null;
  enrichmentSummary: string | null;
  enrichmentTopics: string[] | null;
  /** The current-if-any embedding row's input hash for the specific
   * (provider, model, embeddingVersion) the caller asked about — null if
   * no such row exists yet. Callers recompute today's hash from the
   * returned content fields and compare, exactly like
   * `getEnrichmentCandidates`/`resolveCandidatePool` already do for
   * enrichment — the hash comparison itself is an application-layer
   * concern, never pushed into SQL. */
  existingInputHash: string | null;
}

/**
 * A bounded pool of embedding candidates, most recent first, joined
 * against any existing embedding row for the exact (provider, model,
 * embeddingVersion) triple the caller specifies — never a plain "already
 * embedded by anything" check, since an embedding under a different model
 * is not a cache hit for this one.
 */
export async function getEmbeddingCandidates(options: {
  poolSize: number;
  sourceType?: SourceType;
  /** Restricts candidates to `sourceKey LIKE '<prefix>%'`. Exists so
   * integration tests can scope embedding runs to only the fixtures they
   * seeded (e.g. "embedtest:") instead of the whole corpus matching
   * `sourceType` — never set by any production call site. */
  sourceKeyPrefix?: string;
  provider: string;
  model: string;
  embeddingVersion: number;
}): Promise<EmbeddingCandidate[]> {
  const db = getDb();
  if (!db) return [];

  const conditions: SQL[] = [];
  if (options.sourceType) conditions.push(eq(feedItems.sourceType, options.sourceType));
  if (options.sourceKeyPrefix) conditions.push(like(feedItems.sourceKey, `${options.sourceKeyPrefix}%`));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      feedItemId: feedItems.id,
      sourceKey: feedItems.sourceKey,
      title: feedItems.title,
      summary: feedItems.summary,
      sourceType: feedItems.sourceType,
      sourceName: feedItems.sourceName,
      tags: feedItems.tags,
      authors: feedItems.authors,
      repositoryFullName: feedItems.repositoryFullName,
      enrichmentSummary: articleEnrichments.summary,
      enrichmentTopics: articleEnrichments.topics,
      existingInputHash: feedItemEmbeddings.inputHash,
    })
    .from(feedItems)
    .leftJoin(articleEnrichments, eq(articleEnrichments.feedItemId, feedItems.id))
    .leftJoin(
      feedItemEmbeddings,
      and(
        eq(feedItemEmbeddings.feedItemId, feedItems.id),
        eq(feedItemEmbeddings.provider, options.provider),
        eq(feedItemEmbeddings.model, options.model),
        eq(feedItemEmbeddings.embeddingVersion, options.embeddingVersion)
      )
    )
    .where(whereClause)
    .orderBy(desc(feedItems.publishedAt), desc(feedItems.id))
    .limit(options.poolSize);

  return rows.map((row) => ({
    ...row,
    sourceType: row.sourceType as SourceType,
    existingInputHash: row.existingInputHash ?? null,
  }));
}

/**
 * Idempotent upsert keyed on (feedItemId, provider, model, embeddingVersion)
 * — matches the unique index. A refresh overwrites the vector, hash, and
 * dimensions in place and never accumulates history, exactly like the HN
 * context cache and enrichment tables. The database's own CHECK constraint
 * (`dimensions = vector_dims(embedding)`) is the final backstop against a
 * caller passing a `dimensions` value that doesn't match the actual vector
 * it's storing.
 */
export async function upsertFeedItemEmbedding(input: {
  feedItemId: number;
  provider: string;
  model: string;
  embeddingVersion: number;
  inputHash: string;
  embedding: number[];
  dimensions: number;
}): Promise<void> {
  const db = getDb();
  if (!db) throw new DatabaseError("Embedding storage is temporarily unavailable.");

  try {
    await db
      .insert(feedItemEmbeddings)
      .values(input)
      .onConflictDoUpdate({
        target: [
          feedItemEmbeddings.feedItemId,
          feedItemEmbeddings.provider,
          feedItemEmbeddings.model,
          feedItemEmbeddings.embeddingVersion,
        ],
        set: {
          inputHash: input.inputHash,
          embedding: input.embedding,
          dimensions: input.dimensions,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    logDbError("upsertFeedItemEmbedding", error);
    throw new DatabaseError("Embedding storage is temporarily unavailable.");
  }
}

export interface VectorSearchOptions {
  queryEmbedding: number[];
  provider: string;
  model: string;
  embeddingVersion: number;
  sourceType?: SourceType;
  sourceId?: string;
  sinceDays?: number;
  bookmarkedOnly?: boolean;
  limit: number;
}

export interface VectorSearchResultRow {
  item: FeedItem;
  /** Cosine distance (pgvector's `<=>` operator) — lower is more similar.
   * Never compared across a different model/dimensionality. */
  distance: number;
}

const MAX_VECTOR_SEARCH_LIMIT = 50;

/**
 * Exact (non-ANN) nearest-neighbor search via pgvector's `<=>` cosine
 * distance operator — see the Step 17 final report for the EXPLAIN
 * ANALYZE evidence behind not adding an HNSW/IVFFlat index yet. Applies
 * the same filter shapes as `searchFeedItems` (source/publisher/time/
 * bookmark), so semantic and lexical retrieval stay directly comparable
 * for the same query. Bounded: `limit` is clamped, and this is the only
 * place a query embedding is ever compared against stored vectors — never
 * an unbounded table scan without a LIMIT.
 */
export async function vectorSearchFeedItems(options: VectorSearchOptions): Promise<VectorSearchResultRow[]> {
  const db = getDb();
  if (!db) throw new DatabaseError("Semantic search is temporarily unavailable.");

  const limit = Math.min(Math.max(options.limit, 1), MAX_VECTOR_SEARCH_LIMIT);
  const queryVectorLiteral = `[${options.queryEmbedding.join(",")}]`;
  const distanceExpr = sql<number>`${feedItemEmbeddings.embedding} <=> ${queryVectorLiteral}::vector`;

  const conditions: SQL[] = [
    eq(feedItemEmbeddings.provider, options.provider),
    eq(feedItemEmbeddings.model, options.model),
    eq(feedItemEmbeddings.embeddingVersion, options.embeddingVersion),
    // Defensive, not merely theoretical: pgvector's `<=>` throws at query
    // time on a dimension mismatch rather than silently comparing partial
    // vectors — this filters those rows out instead of failing the whole
    // search, in the unlikely event of an inconsistent row under the same
    // model/version key.
    eq(feedItemEmbeddings.dimensions, options.queryEmbedding.length),
  ];
  if (options.sourceType) conditions.push(eq(feedItems.sourceType, options.sourceType));
  if (options.sourceId) conditions.push(eq(feedItems.sourceId, options.sourceId));
  if (options.sinceDays) {
    conditions.push(gte(feedItems.publishedAt, sql`now() - make_interval(days => ${options.sinceDays})`));
  }
  if (options.bookmarkedOnly) conditions.push(sql`${bookmarks.id} is not null`);

  try {
    const rows = await db
      .select({ item: feedItems, distance: distanceExpr })
      .from(feedItemEmbeddings)
      .innerJoin(feedItems, eq(feedItems.id, feedItemEmbeddings.feedItemId))
      .leftJoin(bookmarks, eq(bookmarks.feedItemId, feedItems.id))
      .where(and(...conditions))
      .orderBy(asc(distanceExpr))
      .limit(limit);

    return rows.map((row) => ({ item: rowToFeedItem(row.item), distance: row.distance }));
  } catch (error) {
    logDbError("vectorSearchFeedItems", error);
    throw new DatabaseError("Semantic search is temporarily unavailable.");
  }
}

const RELATED_ITEMS_POOL_MULTIPLIER = 3;
const MAX_RELATED_ITEMS = 12;
// No more than this many of the returned items may share one sourceType —
// a lightweight diversity guard, not a scoring system (Step 19 §5: "don't
// build a recommendation engine").
const MAX_PER_SOURCE_TYPE = 3;

export interface RelatedFeedItem {
  item: FeedItem;
  /** Internal DB id — the app-level `FeedItem.id` is the external
   * sourceKey, but the `/item/[id]` detail route needs the numeric id
   * (see `getFeedItemById`), so it travels alongside each related item
   * rather than requiring a second lookup per row. */
  feedItemId: number;
}

function applySourceTypeDiversityCap(rows: RelatedFeedItem[], limit: number): RelatedFeedItem[] {
  const perType = new Map<SourceType, number>();
  const kept: RelatedFeedItem[] = [];
  const overflow: RelatedFeedItem[] = [];

  for (const row of rows) {
    const count = perType.get(row.item.sourceType) ?? 0;
    if (count < MAX_PER_SOURCE_TYPE) {
      perType.set(row.item.sourceType, count + 1);
      kept.push(row);
    } else {
      overflow.push(row);
    }
    if (kept.length >= limit) return kept;
  }
  // Fewer than `limit` distinct-enough items exist — top up from overflow
  // rather than under-filling a bounded "related" section over a cap that
  // was only ever meant to diversify, not to shrink the result.
  return [...kept, ...overflow].slice(0, limit);
}

/**
 * Deterministic, database-only "Related" items for the Step 19 detail page.
 * Never calls an embedding provider — this only ever compares vectors
 * ALREADY stored by the existing Step 17 embedding pipeline, or falls back
 * to the existing full-text search infrastructure. Three-tier hierarchy,
 * cheapest/most-relevant first:
 *
 *   1. This item's own most-recent stored embedding (if any) drives a
 *      pgvector nearest-neighbor scan among other items embedded under the
 *      same (provider, model, embeddingVersion) — reuses the exact index
 *      and distance operator `vectorSearchFeedItems` already uses.
 *   2. No stored embedding for this item: fall back to lexical similarity,
 *      using the item's own title as a `websearch_to_tsquery` against the
 *      existing `search_vector` GIN index (the same machinery
 *      `searchFeedItems` uses for a user's typed query) — comparably cheap,
 *      zero new infrastructure.
 *   3. Neither produces results (e.g. an all-stopword title): return `[]`
 *      and let the page omit the section entirely, rather than forcing an
 *      unrelated result to appear.
 *
 * A corpus-appropriate choice: this dev corpus's embedding coverage is
 * partial (see the Step 19 final report), so a strategy that degrades
 * gracefully to lexical rather than showing nothing for half the corpus is
 * the right default — and both tiers already exist and are proven, so nothing
 * new needed inventing beyond this ordering + the diversity cap above.
 */
export async function getRelatedFeedItems(feedItemId: number, limit: number): Promise<RelatedFeedItem[]> {
  const db = getDb();
  if (!db) return [];

  const boundedLimit = Math.min(Math.max(limit, 1), MAX_RELATED_ITEMS);
  const poolSize = Math.min(boundedLimit * RELATED_ITEMS_POOL_MULTIPLIER, MAX_RELATED_ITEMS * RELATED_ITEMS_POOL_MULTIPLIER);

  try {
    const [ownEmbedding] = await db
      .select({
        provider: feedItemEmbeddings.provider,
        model: feedItemEmbeddings.model,
        embeddingVersion: feedItemEmbeddings.embeddingVersion,
        embedding: feedItemEmbeddings.embedding,
      })
      .from(feedItemEmbeddings)
      .where(eq(feedItemEmbeddings.feedItemId, feedItemId))
      .orderBy(desc(feedItemEmbeddings.updatedAt))
      .limit(1);

    if (ownEmbedding) {
      const queryVectorLiteral = `[${ownEmbedding.embedding.join(",")}]`;
      const distanceExpr = sql<number>`${feedItemEmbeddings.embedding} <=> ${queryVectorLiteral}::vector`;
      const rows = await db
        .select({ item: feedItems, distance: distanceExpr })
        .from(feedItemEmbeddings)
        .innerJoin(feedItems, eq(feedItems.id, feedItemEmbeddings.feedItemId))
        .where(
          and(
            eq(feedItemEmbeddings.provider, ownEmbedding.provider),
            eq(feedItemEmbeddings.model, ownEmbedding.model),
            eq(feedItemEmbeddings.embeddingVersion, ownEmbedding.embeddingVersion),
            ne(feedItemEmbeddings.feedItemId, feedItemId)
          )
        )
        .orderBy(asc(distanceExpr))
        .limit(poolSize);

      return applySourceTypeDiversityCap(
        rows.map((row) => ({ item: rowToFeedItem(row.item), feedItemId: row.item.id })),
        boundedLimit
      );
    }

    // Fallback: lexical similarity via the item's own title, reusing the
    // exact same generated search_vector/GIN index as ordinary text search.
    const [self] = await db.select({ title: feedItems.title }).from(feedItems).where(eq(feedItems.id, feedItemId)).limit(1);
    if (!self) return [];

    const tsQuery = sql`websearch_to_tsquery('english', ${self.title})`;
    const rankExpr = sql<number>`ts_rank_cd(${feedItems.searchVector}, ${tsQuery})`;
    const rows = await db
      .select({ item: feedItems, rank: rankExpr })
      .from(feedItems)
      .where(and(sql`${feedItems.searchVector} @@ ${tsQuery}`, ne(feedItems.id, feedItemId)))
      .orderBy(desc(rankExpr), desc(feedItems.publishedAt))
      .limit(poolSize);

    return applySourceTypeDiversityCap(
      rows.map((row) => ({ item: rowToFeedItem(row.item), feedItemId: row.item.id })),
      boundedLimit
    );
  } catch (error) {
    logDbError("getRelatedFeedItems", error);
    // Related items are a nice-to-have discovery aid, never load-bearing —
    // a failure here degrades to "no related items shown," not a broken page.
    return [];
  }
}

export interface EmbeddingStats {
  totalFeedItems: number;
  embeddedFeedItems: number;
  /** Distinct (provider, model, embeddingVersion) triples currently
   * present — normally 0 or 1 in steady state; briefly 2 only while
   * comparing two models or migrating to a new embedding schema version. */
  distinctModelVersions: number;
}

/**
 * Aggregate, secret-free snapshot for CLI observability — never returns
 * vector contents.
 */
export async function getEmbeddingStats(): Promise<EmbeddingStats> {
  const empty: EmbeddingStats = { totalFeedItems: 0, embeddedFeedItems: 0, distinctModelVersions: 0 };
  const db = getDb();
  if (!db) return empty;

  const [[{ totalFeedItems }], [{ embeddedFeedItems }], [{ distinctModelVersions }]] = await Promise.all([
    db.select({ totalFeedItems: sql<number>`count(*)::int` }).from(feedItems),
    db
      .select({ embeddedFeedItems: sql<number>`count(distinct ${feedItemEmbeddings.feedItemId})::int` })
      .from(feedItemEmbeddings),
    db
      .select({
        distinctModelVersions: sql<number>`count(distinct (${feedItemEmbeddings.provider}, ${feedItemEmbeddings.model}, ${feedItemEmbeddings.embeddingVersion}))::int`,
      })
      .from(feedItemEmbeddings),
  ]);

  return { totalFeedItems, embeddedFeedItems, distinctModelVersions };
}

// --- Source health (Step 21) --------------------------------------------

export interface SourceHealthSummary {
  sourceKey: string;
  sourceLabel: string;
  lastAttemptedAt: Date | null;
  lastSucceededAt: Date | null;
  lastSuccessItemCount: number | null;
  lastStatus: SourceHealthStatus;
  lastErrorCategory: SourceHealthErrorCategory | null;
  lastErrorMessage: string | null;
}

function rowToSourceHealthSummary(row: SourceHealthRow): SourceHealthSummary {
  return {
    sourceKey: row.sourceKey,
    sourceLabel: row.sourceLabel,
    lastAttemptedAt: row.lastAttemptedAt,
    lastSucceededAt: row.lastSucceededAt,
    lastSuccessItemCount: row.lastSuccessItemCount,
    lastStatus: row.lastStatus as SourceHealthStatus,
    lastErrorCategory: row.lastErrorCategory as SourceHealthErrorCategory | null,
    lastErrorMessage: row.lastErrorMessage,
  };
}

/**
 * Every source's current health snapshot, for the UI panel and the CLI. A
 * source with no row at all (never attempted since this table existed)
 * simply isn't in the returned array — callers merge against the known
 * configured source list to show "Never refreshed" for those.
 */
export async function getAllSourceHealth(): Promise<SourceHealthSummary[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db.select().from(sourceHealth).orderBy(asc(sourceHealth.sourceKey));
  return rows.map(rowToSourceHealthSummary);
}

/**
 * Records that a refresh attempt started, without asserting an outcome —
 * `lastStatus` (and every other outcome column) is left exactly as it was
 * from the previous completed attempt until `recordSourceHealthSuccess`/
 * `recordSourceHealthFailure` resolves it. This is what lets "last
 * attempted" and "last succeeded" genuinely diverge (Step 21 §4's "when
 * was this source last attempted vs. last succeeded" distinction) rather
 * than always being the same timestamp.
 */
export async function recordSourceHealthAttempt(sourceKey: string, sourceLabel: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .insert(sourceHealth)
      .values({ sourceKey, sourceLabel, lastAttemptedAt: sql`now()` })
      .onConflictDoUpdate({
        target: sourceHealth.sourceKey,
        set: { lastAttemptedAt: sql`now()`, sourceLabel: sql`excluded.source_label`, updatedAt: sql`now()` },
      });
  } catch (error) {
    // Health bookkeeping is observability, never load-bearing — a failure
    // here must not abort or fail the refresh itself.
    logDbError("recordSourceHealthAttempt", error);
  }
}

export async function recordSourceHealthSuccess(sourceKey: string, sourceLabel: string, itemCount: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .insert(sourceHealth)
      .values({
        sourceKey,
        sourceLabel,
        lastAttemptedAt: sql`now()`,
        lastSucceededAt: sql`now()`,
        lastSuccessItemCount: itemCount,
        lastStatus: "success",
      })
      .onConflictDoUpdate({
        target: sourceHealth.sourceKey,
        set: {
          sourceLabel: sql`excluded.source_label`,
          lastAttemptedAt: sql`excluded.last_attempted_at`,
          lastSucceededAt: sql`excluded.last_succeeded_at`,
          lastSuccessItemCount: sql`excluded.last_success_item_count`,
          lastStatus: "success",
          lastErrorCategory: null,
          lastErrorMessage: null,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    logDbError("recordSourceHealthSuccess", error);
  }
}

const MAX_ERROR_MESSAGE_LENGTH = 512;

/**
 * Records a failed attempt. Deliberately never touches `lastSucceededAt`/
 * `lastSuccessItemCount` in the update branch (Step 21 §9: "a failed
 * attempt should not overwrite lastSuccessfulAt") — the SET clause simply
 * omits them, leaving whatever was last persisted there untouched.
 * `errorMessage` must already be sanitized by the caller (see
 * refreshService.ts) — this only enforces a length bound as a last resort.
 */
export async function recordSourceHealthFailure(
  sourceKey: string,
  sourceLabel: string,
  errorCategory: SourceHealthErrorCategory,
  errorMessage: string
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const truncatedMessage = errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  try {
    await db
      .insert(sourceHealth)
      .values({
        sourceKey,
        sourceLabel,
        lastAttemptedAt: sql`now()`,
        lastStatus: "failed",
        lastErrorCategory: errorCategory,
        lastErrorMessage: truncatedMessage,
      })
      .onConflictDoUpdate({
        target: sourceHealth.sourceKey,
        set: {
          sourceLabel: sql`excluded.source_label`,
          lastAttemptedAt: sql`excluded.last_attempted_at`,
          lastStatus: "failed",
          lastErrorCategory: errorCategory,
          lastErrorMessage: truncatedMessage,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    logDbError("recordSourceHealthFailure", error);
  }
}

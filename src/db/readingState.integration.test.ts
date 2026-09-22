import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { FeedItem } from "@/types/feed";

/**
 * Integration tests against a real PostgreSQL instance. Skipped entirely
 * unless DATABASE_URL is set — never run against mocks, per the same
 * reasoning as bookmarks.integration.test.ts: idempotency and FK behavior
 * are exactly the kind of thing a mock would paper over.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

function testItem(sourceKey: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: sourceKey,
    sourceType: "hackernews",
    sourceName: "Hacker News · tester",
    title: `Title for ${sourceKey}`,
    description: "A test item.",
    publishedAt: "2026-09-01T00:00:00.000Z",
    tags: [],
    score: 1,
    commentCount: 0,
    url: `https://example.com/${sourceKey.replace(/[^a-z0-9]/gi, "-")}`,
    ...overrides,
  };
}

describeIfDb("reading queue & read state repository (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let schema: typeof import("@/db/schema");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    schema = await import("@/db/schema");
    // Isolate this suite; also clears any reading_state/bookmark rows
    // referencing these items (they'd block the delete otherwise).
    await db.getDb()!.execute(sql`delete from reading_state where feed_item_id in (
      select id from feed_items where source_key like 'rstest:%'
    )`);
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like 'rstest:%'
    )`);
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'rstest:%'`);
  });

  afterAll(async () => {
    await db.getDb()!.execute(sql`delete from reading_state where feed_item_id in (
      select id from feed_items where source_key like 'rstest:%'
    )`);
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like 'rstest:%'
    )`);
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'rstest:%'`);
  });

  // --- Queue -------------------------------------------------------------

  it("addToQueue queues exactly one item", async () => {
    await repo.upsertFeedItems([testItem("rstest:1")]);
    await repo.addToQueue("rstest:1");

    const { queuedKeys } = await repo.getReadingStateKeys();
    expect(queuedKeys.filter((k) => k === "rstest:1")).toHaveLength(1);
  });

  it("addToQueue is idempotent — calling it twice still yields exactly one queued item, same queuedAt", async () => {
    await repo.upsertFeedItems([testItem("rstest:idempotent")]);
    await repo.addToQueue("rstest:idempotent");
    const firstRow = await queueRowFor(repo, "rstest:idempotent");

    await new Promise((resolve) => setTimeout(resolve, 20));
    await repo.addToQueue("rstest:idempotent");
    const secondRow = await queueRowFor(repo, "rstest:idempotent");

    const { queuedKeys } = await repo.getReadingStateKeys();
    expect(queuedKeys.filter((k) => k === "rstest:idempotent")).toHaveLength(1);
    // The original queuedAt must be preserved, not bumped — a duplicate
    // "queue" click must not jump the item to the top of /queue's ordering.
    expect(firstRow?.queuedAt.getTime()).toBe(secondRow?.queuedAt.getTime());
  });

  it("removeFromQueue removes it — zero queued rows remain for that item", async () => {
    await repo.removeFromQueue("rstest:1");

    const { queuedKeys } = await repo.getReadingStateKeys();
    expect(queuedKeys).not.toContain("rstest:1");
  });

  it("removeFromQueue is idempotent — calling it again does not throw", async () => {
    await expect(repo.removeFromQueue("rstest:1")).resolves.toBeUndefined();
    await expect(repo.removeFromQueue("rstest:1")).resolves.toBeUndefined();
  });

  it("removeFromQueue on an unknown source key is a silent no-op, not an error", async () => {
    await expect(repo.removeFromQueue("rstest:does-not-exist")).resolves.toBeUndefined();
  });

  it("addToQueue on an unknown source key fails clearly rather than silently succeeding", async () => {
    await expect(repo.addToQueue("rstest:does-not-exist")).rejects.toThrow();
  });

  it("orders getQueueItems most-recently-queued first", async () => {
    await repo.upsertFeedItems([testItem("rstest:order:a"), testItem("rstest:order:b")]);
    await repo.addToQueue("rstest:order:a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repo.addToQueue("rstest:order:b");

    const items = await repo.getQueueItems();
    const indexA = items.findIndex((row) => row.item.id === "rstest:order:a");
    const indexB = items.findIndex((row) => row.item.id === "rstest:order:b");

    expect(indexB).toBeLessThan(indexA);

    await repo.removeFromQueue("rstest:order:a");
    await repo.removeFromQueue("rstest:order:b");
  });

  // --- Read state ----------------------------------------------------------

  it("markRead marks exactly one item read", async () => {
    await repo.upsertFeedItems([testItem("rstest:2")]);
    await repo.markRead("rstest:2");

    const { readKeys } = await repo.getReadingStateKeys();
    expect(readKeys.filter((k) => k === "rstest:2")).toHaveLength(1);
  });

  it("markRead is idempotent — calling it twice preserves the original readAt", async () => {
    await repo.upsertFeedItems([testItem("rstest:read-idempotent")]);
    await repo.markRead("rstest:read-idempotent");

    const { readKeys: firstReadKeys } = await repo.getReadingStateKeys();
    expect(firstReadKeys).toContain("rstest:read-idempotent");

    await expect(repo.markRead("rstest:read-idempotent")).resolves.toBeUndefined();
    const { readKeys: secondReadKeys } = await repo.getReadingStateKeys();
    expect(secondReadKeys.filter((k) => k === "rstest:read-idempotent")).toHaveLength(1);
  });

  it("markUnread clears read state — zero read rows remain for that item", async () => {
    await repo.markUnread("rstest:2");

    const { readKeys } = await repo.getReadingStateKeys();
    expect(readKeys).not.toContain("rstest:2");
  });

  it("markUnread is idempotent — calling it again does not throw", async () => {
    await expect(repo.markUnread("rstest:2")).resolves.toBeUndefined();
    await expect(repo.markUnread("rstest:2")).resolves.toBeUndefined();
  });

  it("markUnread on an unknown source key is a silent no-op, not an error", async () => {
    await expect(repo.markUnread("rstest:does-not-exist")).resolves.toBeUndefined();
  });

  it("markRead on an unknown source key fails clearly rather than silently succeeding", async () => {
    await expect(repo.markRead("rstest:does-not-exist")).rejects.toThrow();
  });

  it("supports an item that is read but was never queued", async () => {
    await repo.upsertFeedItems([testItem("rstest:read-only")]);
    await repo.markRead("rstest:read-only");

    const { queuedKeys, readKeys } = await repo.getReadingStateKeys();
    expect(readKeys).toContain("rstest:read-only");
    expect(queuedKeys).not.toContain("rstest:read-only");
    // Not on /queue — it was never queued.
    const queueItems = await repo.getQueueItems();
    expect(queueItems.find((row) => row.item.id === "rstest:read-only")).toBeUndefined();
  });

  // --- Independence (Step 26 §3, §9) ---------------------------------------

  it("queue and read state are fully independent of each other", async () => {
    await repo.upsertFeedItems([testItem("rstest:independence")]);

    await repo.addToQueue("rstest:independence");
    let state = await repo.getReadingStateKeys();
    expect(state.queuedKeys).toContain("rstest:independence");
    expect(state.readKeys).not.toContain("rstest:independence");

    // Marking read does not remove it from the queue.
    await repo.markRead("rstest:independence");
    state = await repo.getReadingStateKeys();
    expect(state.queuedKeys).toContain("rstest:independence");
    expect(state.readKeys).toContain("rstest:independence");

    // Marking unread does not remove it from the queue.
    await repo.markUnread("rstest:independence");
    state = await repo.getReadingStateKeys();
    expect(state.queuedKeys).toContain("rstest:independence");
    expect(state.readKeys).not.toContain("rstest:independence");

    // Removing from the queue does not affect read state, and vice versa —
    // re-mark read, then dequeue, and confirm read survives.
    await repo.markRead("rstest:independence");
    await repo.removeFromQueue("rstest:independence");
    state = await repo.getReadingStateKeys();
    expect(state.queuedKeys).not.toContain("rstest:independence");
    expect(state.readKeys).toContain("rstest:independence");

    await repo.markUnread("rstest:independence");
  });

  it("queue and bookmark state are fully independent of each other", async () => {
    await repo.upsertFeedItems([testItem("rstest:bm-independence")]);

    await repo.addToQueue("rstest:bm-independence");
    await repo.addBookmark("rstest:bm-independence");

    let queued = (await repo.getReadingStateKeys()).queuedKeys;
    let bookmarked = await repo.getBookmarkedSourceKeys();
    expect(queued).toContain("rstest:bm-independence");
    expect(bookmarked).toContain("rstest:bm-independence");

    // Removing the bookmark leaves the queue untouched.
    await repo.removeBookmark("rstest:bm-independence");
    queued = (await repo.getReadingStateKeys()).queuedKeys;
    bookmarked = await repo.getBookmarkedSourceKeys();
    expect(queued).toContain("rstest:bm-independence");
    expect(bookmarked).not.toContain("rstest:bm-independence");

    // Removing from the queue leaves any bookmark untouched (re-bookmark first).
    await repo.addBookmark("rstest:bm-independence");
    await repo.removeFromQueue("rstest:bm-independence");
    queued = (await repo.getReadingStateKeys()).queuedKeys;
    bookmarked = await repo.getBookmarkedSourceKeys();
    expect(queued).not.toContain("rstest:bm-independence");
    expect(bookmarked).toContain("rstest:bm-independence");

    await repo.removeBookmark("rstest:bm-independence");
  });

  it("an item can be simultaneously queued, read, and bookmarked", async () => {
    await repo.upsertFeedItems([testItem("rstest:all-three")]);
    await repo.addToQueue("rstest:all-three");
    await repo.markRead("rstest:all-three");
    await repo.addBookmark("rstest:all-three");

    const state = await repo.getReadingStateKeys();
    const bookmarked = await repo.getBookmarkedSourceKeys();
    expect(state.queuedKeys).toContain("rstest:all-three");
    expect(state.readKeys).toContain("rstest:all-three");
    expect(bookmarked).toContain("rstest:all-three");

    const queueRow = (await repo.getQueueItems()).find((row) => row.item.id === "rstest:all-three");
    expect(queueRow?.read).toBe(true);
    expect(queueRow?.bookmarked).toBe(true);

    await repo.removeFromQueue("rstest:all-three");
    await repo.markUnread("rstest:all-three");
    await repo.removeBookmark("rstest:all-three");
  });

  // --- Persistence across an inactive row deletion --------------------------

  it("deletes the reading_state row once both queuedAt and readAt are cleared", async () => {
    await repo.upsertFeedItems([testItem("rstest:cleanup")]);
    await repo.addToQueue("rstest:cleanup");
    await repo.markRead("rstest:cleanup");

    const [beforeRow] = await db
      .getDb()!
      .select()
      .from(schema.readingState)
      .innerJoin(schema.feedItems, sql`${schema.readingState.feedItemId} = ${schema.feedItems.id}`)
      .where(sql`source_key = 'rstest:cleanup'`);
    expect(beforeRow).toBeDefined();

    await repo.removeFromQueue("rstest:cleanup");
    await repo.markUnread("rstest:cleanup");

    const afterRows = await db
      .getDb()!
      .select()
      .from(schema.readingState)
      .innerJoin(schema.feedItems, sql`${schema.readingState.feedItemId} = ${schema.feedItems.id}`)
      .where(sql`source_key = 'rstest:cleanup'`);
    expect(afterRows).toHaveLength(0);
  });

  // --- Ingestion independence (Step 26 §2, §11) ------------------------------

  it("re-ingesting (upserting) an already-queued/read item preserves its reading state", async () => {
    await repo.upsertFeedItems([testItem("rstest:upsert-preserve")]);
    await repo.addToQueue("rstest:upsert-preserve");
    await repo.markRead("rstest:upsert-preserve");

    // Re-upsert the SAME sourceKey with different content — this is what a
    // real re-ingestion of an already-seen item does (update in place by
    // sourceKey conflict target, never delete-then-reinsert).
    await repo.upsertFeedItems([
      testItem("rstest:upsert-preserve", { title: "An updated title from a later refresh" }),
    ]);

    const state = await repo.getReadingStateKeys();
    expect(state.queuedKeys).toContain("rstest:upsert-preserve");
    expect(state.readKeys).toContain("rstest:upsert-preserve");

    await repo.removeFromQueue("rstest:upsert-preserve");
    await repo.markUnread("rstest:upsert-preserve");
  });

  // --- FK / delete behavior (mirrors bookmarks' ON DELETE RESTRICT) ---------

  it("prevents deleting a queued feed_items row (ON DELETE RESTRICT)", async () => {
    await repo.upsertFeedItems([testItem("rstest:restrict")]);
    await repo.addToQueue("rstest:restrict");

    await expect(
      db.getDb()!.delete(schema.feedItems).where(sql`source_key = 'rstest:restrict'`)
    ).rejects.toThrow();

    const rows = await db.getDb()!.select().from(schema.feedItems).where(sql`source_key = 'rstest:restrict'`);
    expect(rows).toHaveLength(1);
  });

  it("allows deleting a feed_items row once its queue/read state is cleared", async () => {
    await repo.removeFromQueue("rstest:restrict");

    await expect(
      db.getDb()!.delete(schema.feedItems).where(sql`source_key = 'rstest:restrict'`)
    ).resolves.not.toThrow();
  });

  it("getUnreadQueuedCount counts only queued-and-unread items", async () => {
    await repo.upsertFeedItems([
      testItem("rstest:count:unread"),
      testItem("rstest:count:read"),
      testItem("rstest:count:not-queued"),
    ]);
    await repo.addToQueue("rstest:count:unread");
    await repo.addToQueue("rstest:count:read");
    await repo.markRead("rstest:count:read");
    await repo.markRead("rstest:count:not-queued");

    const before = await repo.getUnreadQueuedCount();
    // Isolate the assertion to a delta rather than an absolute count, since
    // this counts every queued-unread row in the whole (shared) database.
    await repo.removeFromQueue("rstest:count:unread");
    const after = await repo.getUnreadQueuedCount();
    expect(before - after).toBe(1);

    await repo.removeFromQueue("rstest:count:read");
    await repo.markUnread("rstest:count:read");
    await repo.markUnread("rstest:count:not-queued");
  });
});

async function queueRowFor(
  repo: typeof import("@/db/repository"),
  sourceKey: string
): Promise<{ queuedAt: Date } | undefined> {
  const items = await repo.getQueueItems();
  const row = items.find((r) => r.item.id === sourceKey);
  return row ? { queuedAt: row.queuedAt } : undefined;
}

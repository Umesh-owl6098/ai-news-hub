import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { FeedItem } from "@/types/feed";

/**
 * Integration tests against a real PostgreSQL instance. Skipped entirely
 * unless DATABASE_URL is set. Never run against mocks — bookmark
 * idempotency and FK behavior are exactly the kind of thing a mock would
 * paper over.
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

describeIfDb("bookmarks repository (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let schema: typeof import("@/db/schema");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    schema = await import("@/db/schema");
    // Isolate this suite; also clears any bookmarks referencing these rows
    // (bookmarks would block the delete otherwise — see the FK test below).
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like 'bmtest:%'
    )`);
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'bmtest:%'`);
  });

  afterAll(async () => {
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like 'bmtest:%'
    )`);
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'bmtest:%'`);
  });

  it("addBookmark creates exactly one bookmark", async () => {
    await repo.upsertFeedItems([testItem("bmtest:1")]);
    await repo.addBookmark("bmtest:1");

    const keys = await repo.getBookmarkedSourceKeys();
    expect(keys.filter((k) => k === "bmtest:1")).toHaveLength(1);
  });

  it("addBookmark is idempotent — calling it twice still yields exactly one bookmark", async () => {
    await repo.addBookmark("bmtest:1");
    await repo.addBookmark("bmtest:1");

    const keys = await repo.getBookmarkedSourceKeys();
    expect(keys.filter((k) => k === "bmtest:1")).toHaveLength(1);
  });

  it("removeBookmark removes it — zero bookmarks remain for that item", async () => {
    await repo.removeBookmark("bmtest:1");

    const keys = await repo.getBookmarkedSourceKeys();
    expect(keys).not.toContain("bmtest:1");
  });

  it("removeBookmark is idempotent — calling it again does not throw", async () => {
    await expect(repo.removeBookmark("bmtest:1")).resolves.toBeUndefined();
    await expect(repo.removeBookmark("bmtest:1")).resolves.toBeUndefined();
  });

  it("removeBookmark on an unknown source key is a silent no-op, not an error", async () => {
    await expect(repo.removeBookmark("bmtest:does-not-exist")).resolves.toBeUndefined();
  });

  it("addBookmark on an unknown source key fails clearly rather than silently succeeding", async () => {
    await expect(repo.addBookmark("bmtest:does-not-exist")).rejects.toThrow();
  });

  it("supports multiple independent bookmarks across different feed items", async () => {
    await repo.upsertFeedItems([testItem("bmtest:2"), testItem("bmtest:3")]);
    await repo.addBookmark("bmtest:2");
    await repo.addBookmark("bmtest:3");

    const keys = await repo.getBookmarkedSourceKeys();
    expect(keys).toEqual(expect.arrayContaining(["bmtest:2", "bmtest:3"]));
  });

  it("bookmarks the same canonical URL from two different sources independently", async () => {
    const sharedUrl = "https://example.com/bmtest-shared-article";
    await repo.upsertFeedItems([
      testItem("bmtest:rss:shared", { sourceType: "news", sourceName: "OpenAI", url: sharedUrl }),
      testItem("bmtest:hn:shared", { sourceType: "hackernews", url: sharedUrl }),
    ]);

    await repo.addBookmark("bmtest:rss:shared");
    await repo.addBookmark("bmtest:hn:shared");

    const keys = await repo.getBookmarkedSourceKeys();
    expect(keys).toEqual(expect.arrayContaining(["bmtest:rss:shared", "bmtest:hn:shared"]));
  });

  it("getBookmarkedFeedItems reconstructs full FeedItem metadata, including source-specific fields", async () => {
    await repo.upsertFeedItems([
      testItem("bmtest:github:1", {
        sourceType: "github",
        sourceName: "GitHub",
        repositoryFullName: "owner/repo",
        owner: "owner",
        language: "TypeScript",
        stars: 42,
        forks: 7,
        tags: ["ai"],
      }),
    ]);
    await repo.addBookmark("bmtest:github:1");

    const items = await repo.getBookmarkedFeedItems();
    const found = items.find((item) => item.id === "bmtest:github:1");

    expect(found).toBeDefined();
    expect(found?.sourceType).toBe("github");
    expect(found?.repositoryFullName).toBe("owner/repo");
    expect(found?.owner).toBe("owner");
    expect(found?.language).toBe("TypeScript");
    expect(found?.stars).toBe(42);
    expect(found?.forks).toBe(7);
    expect(found?.tags).toEqual(["ai"]);
  });

  it("orders getBookmarkedFeedItems most-recently-bookmarked first", async () => {
    await repo.upsertFeedItems([testItem("bmtest:order:a"), testItem("bmtest:order:b")]);
    await repo.addBookmark("bmtest:order:a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repo.addBookmark("bmtest:order:b");

    const items = await repo.getBookmarkedFeedItems();
    const indexA = items.findIndex((item) => item.id === "bmtest:order:a");
    const indexB = items.findIndex((item) => item.id === "bmtest:order:b");

    expect(indexB).toBeLessThan(indexA);
  });

  // --- FK / delete behavior --------------------------------------------
  //
  // Documented choice: bookmarks reference feed_items with
  // `ON DELETE RESTRICT`, not CASCADE. Bookmarks exist to preserve items
  // the owner explicitly chose to keep, so a future feed-retention/pruning
  // job must not be able to silently destroy a bookmarked row just because
  // it deleted the underlying feed_items entry. Deleting a bookmarked
  // feed_items row must fail loudly; the caller has to unbookmark first.
  it("prevents deleting a bookmarked feed_items row (ON DELETE RESTRICT)", async () => {
    await repo.upsertFeedItems([testItem("bmtest:restrict")]);
    await repo.addBookmark("bmtest:restrict");

    await expect(
      db.getDb()!.delete(schema.feedItems).where(sql`source_key = 'bmtest:restrict'`)
    ).rejects.toThrow();

    // The row must still exist — the delete was actually blocked, not
    // silently ignored.
    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'bmtest:restrict'`);
    expect(rows).toHaveLength(1);
  });

  it("allows deleting a feed_items row once its bookmark is removed", async () => {
    await repo.removeBookmark("bmtest:restrict");

    await expect(
      db.getDb()!.delete(schema.feedItems).where(sql`source_key = 'bmtest:restrict'`)
    ).resolves.not.toThrow();
  });
});

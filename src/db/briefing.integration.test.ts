import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { buildBriefing } from "@/lib/briefing";
import { aggregateTopics } from "@/lib/topics";

/**
 * Integration tests for the Step 22 briefing's database layer against a
 * real PostgreSQL instance. Skipped entirely unless DATABASE_URL is set,
 * matching every other *.integration.test.ts file's convention. Uses a
 * "test:briefing:" sourceKey prefix, cleaned up in beforeAll/afterAll —
 * an ownership boundary safe to delete outright, unlike the shared
 * source_health rows other Step 21/22 integration suites snapshot/restore.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("briefing database layer (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let schema: typeof import("@/db/schema");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    schema = await import("@/db/schema");
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'test:briefing:%'`);
  });

  afterEach(async () => {
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like 'test:briefing:%'
    )`);
  });

  afterAll(async () => {
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'test:briefing:%'`);
  });

  it("getFeedItemsForBriefing includes a recent item and excludes one far outside the lookback bound", async () => {
    const recent = new Date();
    const ancient = new Date();
    ancient.setDate(ancient.getDate() - 60); // well past the 14-day lookback bound

    await repo.upsertFeedItems([
      {
        id: "test:briefing:recent",
        sourceType: "github",
        sourceName: "GitHub",
        title: "Recent repo",
        description: "desc",
        publishedAt: recent.toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-recent",
      },
      {
        id: "test:briefing:ancient",
        sourceType: "github",
        sourceName: "GitHub",
        title: "Ancient repo",
        description: "desc",
        publishedAt: ancient.toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-ancient",
      },
    ]);

    const pool = await repo.getFeedItemsForBriefing();
    const ids = pool.map((item) => item.id);
    expect(ids).toContain("test:briefing:recent");
    expect(ids).not.toContain("test:briefing:ancient");
  });

  it("is read-only: calling it does not change feed_items row count or content", async () => {
    const [before] = await db.getDb()!.select({ count: sql<number>`count(*)::int` }).from(schema.feedItems);
    await repo.getFeedItemsForBriefing();
    const [after] = await db.getDb()!.select({ count: sql<number>`count(*)::int` }).from(schema.feedItems);
    expect(after.count).toBe(before.count);
  });

  it("reflects real bookmark state end-to-end", async () => {
    await repo.upsertFeedItems([
      {
        id: "test:briefing:bookmarked",
        sourceType: "hackernews",
        sourceName: "Hacker News",
        title: "A bookmarked item",
        description: "desc",
        publishedAt: new Date().toISOString(),
        tags: [],
        score: 10,
        commentCount: 2,
        url: "https://example.com/test-briefing-bookmarked",
      },
    ]);

    await repo.addBookmark("test:briefing:bookmarked");
    const bookmarkedKeys = await repo.getBookmarkedSourceKeys();
    const bookmarkedSet = new Set(bookmarkedKeys);

    const pool = await repo.getFeedItemsForBriefing();
    const item = pool.find((i) => i.id === "test:briefing:bookmarked");
    expect(item).toBeDefined();
    expect(bookmarkedSet.has(item!.id)).toBe(true);

    // A different, never-bookmarked item in the same pool must not be
    // reported as bookmarked — proves this isn't a false positive from an
    // always-true lookup.
    await repo.upsertFeedItems([
      {
        id: "test:briefing:not-bookmarked",
        sourceType: "hackernews",
        sourceName: "Hacker News",
        title: "Not bookmarked",
        description: "desc",
        publishedAt: new Date().toISOString(),
        tags: [],
        score: 5,
        commentCount: 1,
        url: "https://example.com/test-briefing-not-bookmarked",
      },
    ]);
    expect(bookmarkedSet.has("test:briefing:not-bookmarked")).toBe(false);
  });

  it("buildBriefing sections a real seeded multi-source pool exactly as the pure unit tests predict", async () => {
    const now = new Date();
    await repo.upsertFeedItems([
      {
        id: "test:briefing:mix-paper",
        sourceType: "paper",
        sourceName: "arXiv",
        title: "A paper",
        description: "desc",
        publishedAt: now.toISOString(),
        tags: ["cs.AI"],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-mix-paper",
      },
      {
        id: "test:briefing:mix-github",
        sourceType: "github",
        sourceName: "GitHub",
        title: "A repo",
        description: "desc",
        publishedAt: now.toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-mix-github",
        stars: 42,
      },
    ]);

    const pool = await repo.getFeedItemsForBriefing();
    const sections = buildBriefing(pool, { now });
    const allSectionIds = [...sections.topStories, ...sections.research, ...sections.projects, ...sections.newsAndDiscussion].map(
      (i) => i.id
    );
    // Both freshly-seeded items must appear exactly once across all
    // sections combined (either in Top Stories or their type section,
    // never both, per buildBriefing's dedupe guarantee).
    expect(allSectionIds.filter((id) => id === "test:briefing:mix-paper")).toHaveLength(1);
    expect(allSectionIds.filter((id) => id === "test:briefing:mix-github")).toHaveLength(1);
  });

  it("reuses Step 20's Topics aggregation for Active Topics without reimplementing it", async () => {
    await repo.upsertFeedItems([
      {
        id: "test:briefing:topic-item",
        sourceType: "paper",
        sourceName: "arXiv",
        title: "A tagged paper",
        description: "desc",
        publishedAt: new Date().toISOString(),
        tags: ["test-briefing-unique-topic"],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-topic-item",
      },
    ]);

    const rows = await repo.getFeedItemsForTopics({ sinceDays: 7 });
    const topics = aggregateTopics(rows);
    const topic = topics.find((t) => t.slug === "test-briefing-unique-topic");
    expect(topic).toBeDefined();
    expect(topic!.items.some((i) => i.id === "test:briefing:topic-item")).toBe(true);
  });

  // --- Step 28: historical reconstruction ----------------------------------

  async function setCreatedAt(sourceKey: string, createdAt: Date): Promise<void> {
    // upsertFeedItems' onConflictDoUpdate never touches created_at (by
    // design — see repository.ts), so there is no app-level API to
    // control first-ingestion time; this direct SQL write exists only to
    // simulate "ingested at a specific instant" for this test, the same
    // way hnContextCache.integration.test.ts's makeStale() backdates a
    // cache row.
    await db.getDb()!.execute(sql`update feed_items set created_at = ${createdAt.toISOString()}::timestamptz where source_key = ${sourceKey}`);
  }

  async function getCreatedAt(sourceKey: string): Promise<Date> {
    const rows = await db
      .getDb()!
      .select({ createdAt: schema.feedItems.createdAt })
      .from(schema.feedItems)
      .where(sql`source_key = ${sourceKey}`);
    return rows[0].createdAt;
  }

  it("historical getFeedItemsForBriefing anchors both bounds to referenceInstant, not the live DB clock", async () => {
    const referenceInstant = new Date("2026-06-15T23:59:59.999Z");
    const justInside = new Date("2026-06-15T12:00:00.000Z"); // within the 14-day lookback, before referenceInstant
    const justAfter = new Date("2026-06-16T00:00:01.000Z"); // one second after referenceInstant

    await repo.upsertFeedItems([
      {
        id: "test:briefing:hist-inside",
        sourceType: "github",
        sourceName: "GitHub",
        title: "Inside historical window",
        description: "desc",
        publishedAt: justInside.toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-hist-inside",
      },
      {
        id: "test:briefing:hist-after",
        sourceType: "github",
        sourceName: "GitHub",
        title: "Published after the historical reference instant",
        description: "desc",
        publishedAt: justAfter.toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-hist-after",
      },
    ]);
    // Fixtures are always really inserted "now" (createdAt defaults to
    // the live clock), which is after any 2026-06 referenceInstant used
    // in this test — backdate createdAt so the new first-ingestion bound
    // (added earlier in this same milestone) doesn't itself exclude a
    // fixture this test wants eligible, independent of publishedAt.
    await setCreatedAt("test:briefing:hist-inside", justInside);
    await setCreatedAt("test:briefing:hist-after", justAfter);

    const pool = await repo.getFeedItemsForBriefing({ referenceInstant });
    const ids = pool.map((item) => item.id);
    expect(ids).toContain("test:briefing:hist-inside");
    expect(ids).not.toContain("test:briefing:hist-after");
  });

  it("historical reconstruction excludes an item published before D but first ingested after D", async () => {
    const referenceInstant = new Date("2026-06-20T23:59:59.999Z");
    const publishedBeforeD = new Date("2026-06-19T10:00:00.000Z");

    await repo.upsertFeedItems([
      {
        id: "test:briefing:late-ingest",
        sourceType: "hackernews",
        sourceName: "Hacker News",
        title: "Published before D, ingested after D",
        description: "desc",
        publishedAt: publishedBeforeD.toISOString(),
        tags: [],
        score: 1,
        commentCount: 0,
        url: "https://example.com/test-briefing-late-ingest",
      },
    ]);
    // Simulate this item not actually being ingested until AFTER D — this
    // hub could not have shown it on D, even though it was published
    // before D and today's fuller corpus now has a row for it.
    await setCreatedAt("test:briefing:late-ingest", new Date("2026-06-22T00:00:00.000Z"));

    const pool = await repo.getFeedItemsForBriefing({ referenceInstant });
    expect(pool.map((item) => item.id)).not.toContain("test:briefing:late-ingest");

    // Sanity check: the SAME item, published the same instant, IS eligible
    // once the reference instant moves past its real ingestion time —
    // proves the exclusion above was the createdAt bound, not the
    // publishedAt bound (which was always satisfied).
    const laterPool = await repo.getFeedItemsForBriefing({ referenceInstant: new Date("2026-06-23T00:00:00.000Z") });
    expect(laterPool.map((item) => item.id)).toContain("test:briefing:late-ingest");
  });

  it("a subsequent upsert does not move the first-ingested (createdAt) timestamp", async () => {
    await repo.upsertFeedItems([
      {
        id: "test:briefing:createdat-stable",
        sourceType: "github",
        sourceName: "GitHub",
        title: "Original title",
        description: "desc",
        publishedAt: new Date().toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-createdat-stable",
      },
    ]);
    const firstCreatedAt = await getCreatedAt("test:briefing:createdat-stable");

    await new Promise((resolve) => setTimeout(resolve, 20));
    await repo.upsertFeedItems([
      {
        id: "test:briefing:createdat-stable",
        sourceType: "github",
        sourceName: "GitHub",
        title: "Updated title from a later re-ingestion",
        description: "desc",
        publishedAt: new Date().toISOString(),
        tags: [],
        score: 99,
        commentCount: 0,
        url: "https://example.com/test-briefing-createdat-stable",
      },
    ]);
    const secondCreatedAt = await getCreatedAt("test:briefing:createdat-stable");

    expect(secondCreatedAt.getTime()).toBe(firstCreatedAt.getTime());
  });

  it("historical Active Topics (getFeedItemsForTopics) excludes evidence published after the reference instant", async () => {
    const referenceInstant = new Date("2026-05-10T23:59:59.999Z");
    await repo.upsertFeedItems([
      {
        id: "test:briefing:topic-hist-before",
        sourceType: "paper",
        sourceName: "arXiv",
        title: "Before the historical reference instant",
        description: "desc",
        publishedAt: "2026-05-10T08:00:00.000Z",
        tags: ["test-briefing-hist-topic"],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-topic-hist-before",
      },
      {
        id: "test:briefing:topic-hist-after",
        sourceType: "paper",
        sourceName: "arXiv",
        title: "After the historical reference instant",
        description: "desc",
        publishedAt: "2026-05-11T08:00:00.000Z",
        tags: ["test-briefing-hist-topic"],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-topic-hist-after",
      },
    ]);
    await setCreatedAt("test:briefing:topic-hist-before", new Date("2026-05-10T08:00:00.000Z"));
    await setCreatedAt("test:briefing:topic-hist-after", new Date("2026-05-11T08:00:00.000Z"));

    const rows = await repo.getFeedItemsForTopics({ sinceDays: 7, referenceInstant });
    const ids = rows.map((row) => row.item.id);
    expect(ids).toContain("test:briefing:topic-hist-before");
    expect(ids).not.toContain("test:briefing:topic-hist-after");
  });

  it("empty historical briefing: a reference instant with no eligible evidence returns all-empty sections, not an error", async () => {
    // A date deliberately far from any real corpus activity and any of
    // this file's own fixtures.
    const referenceInstant = new Date("2020-01-15T23:59:59.999Z");
    const pool = await repo.getFeedItemsForBriefing({ referenceInstant });
    const sections = buildBriefing(pool, { now: referenceInstant });
    expect(sections).toEqual({ topStories: [], research: [], projects: [], newsAndDiscussion: [] });
  });

  it("historical selection is unaffected by current queue/bookmark state (queried independently, not joined)", async () => {
    const referenceInstant = new Date("2026-06-25T23:59:59.999Z");
    await repo.upsertFeedItems([
      {
        id: "test:briefing:hist-state-independence",
        sourceType: "hackernews",
        sourceName: "Hacker News",
        title: "Independent of reading state",
        description: "desc",
        publishedAt: "2026-06-25T10:00:00.000Z",
        tags: [],
        score: 1,
        commentCount: 0,
        url: "https://example.com/test-briefing-hist-state-independence",
      },
    ]);
    await setCreatedAt("test:briefing:hist-state-independence", new Date("2026-06-25T10:00:00.000Z"));

    const poolBefore = await repo.getFeedItemsForBriefing({ referenceInstant });
    expect(poolBefore.map((i) => i.id)).toContain("test:briefing:hist-state-independence");

    await repo.addBookmark("test:briefing:hist-state-independence");
    await repo.addToQueue("test:briefing:hist-state-independence");
    try {
      const poolAfter = await repo.getFeedItemsForBriefing({ referenceInstant });
      // Same membership and same count — bookmarking/queuing neither adds
      // nor removes it from the historical pool.
      expect(poolAfter.map((i) => i.id).sort()).toEqual(poolBefore.map((i) => i.id).sort());
    } finally {
      await repo.removeBookmark("test:briefing:hist-state-independence");
      await repo.removeFromQueue("test:briefing:hist-state-independence");
    }
  });

  it("repeated historical selection against the same persisted data is deterministic", async () => {
    const referenceInstant = new Date("2026-06-18T23:59:59.999Z");
    await repo.upsertFeedItems([
      {
        id: "test:briefing:determinism",
        sourceType: "paper",
        sourceName: "arXiv",
        title: "Deterministic replay",
        description: "desc",
        publishedAt: "2026-06-18T09:00:00.000Z",
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-briefing-determinism",
      },
    ]);
    await setCreatedAt("test:briefing:determinism", new Date("2026-06-18T09:00:00.000Z"));

    const firstPool = await repo.getFeedItemsForBriefing({ referenceInstant });
    const secondPool = await repo.getFeedItemsForBriefing({ referenceInstant });
    const firstSections = buildBriefing(firstPool, { now: referenceInstant });
    const secondSections = buildBriefing(secondPool, { now: referenceInstant });
    expect(secondSections).toEqual(firstSections);
  });
});

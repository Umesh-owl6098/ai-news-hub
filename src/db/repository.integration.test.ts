import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

/**
 * Integration tests against a real PostgreSQL instance. Skipped entirely
 * unless DATABASE_URL is set (e.g. an ephemeral local Docker container) —
 * never run against live external APIs, and never run in a plain
 * `npm run build`/CI environment with no database configured.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("feed_items repository (real PostgreSQL)", () => {
  // Imported lazily inside the guarded describe block so a module-level
  // `postgres(...)` client is never constructed when DATABASE_URL is unset.
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let schema: typeof import("@/db/schema");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    schema = await import("@/db/schema");
    // v1 checkpoint audit: this used to be the bare 'test:%' prefix, which
    // also matches every OTHER integration file's own narrower prefix
    // (test:refresh:, test:health:, test:enrich:, test:briefing:) — a
    // harmless overlap today only because vitest.config.ts's
    // `fileParallelism: false` means files never run concurrently, but a
    // latent trap for whichever file runs next after a crashed/interrupted
    // run leaves residue. Narrowed to this file's own prefix so its cleanup
    // can never touch another file's fixtures, matching the convention
    // every file written since has already followed.
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'test:repo:%'`);
  });

  afterAll(async () => {
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'test:repo:%'`);
  });

  it("creates a new row on first upsert", async () => {
    await repo.upsertFeedItems([
      {
        id: "test:repo:1",
        sourceType: "hackernews",
        sourceName: "Hacker News · alice",
        title: "First Title",
        description: "First description",
        publishedAt: "2026-09-01T00:00:00.000Z",
        tags: ["Hacker News"],
        score: 10,
        commentCount: 2,
        url: "https://example.com/test-1",
      },
    ]);

    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:repo:1'`);

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("First Title");
    expect(rows[0].score).toBe(10);
  });

  it("does not duplicate the row on repeated ingestion of the same source key", async () => {
    for (let i = 0; i < 3; i++) {
      await repo.upsertFeedItems([
        {
          id: "test:repo:1",
          sourceType: "hackernews",
          sourceName: "Hacker News · alice",
          title: "First Title",
          description: "First description",
          publishedAt: "2026-09-01T00:00:00.000Z",
          tags: ["Hacker News"],
          score: 10,
          commentCount: 2,
          url: "https://example.com/test-1",
        },
      ]);
    }

    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:repo:1'`);

    expect(rows).toHaveLength(1);
  });

  it("updates mutable fields (e.g. score) and lastSeenAt on re-ingestion", async () => {
    const before = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:repo:1'`);
    const lastSeenBefore = before[0].lastSeenAt.getTime();

    // Ensure a measurable time delta for last_seen_at.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await repo.upsertFeedItems([
      {
        id: "test:repo:1",
        sourceType: "hackernews",
        sourceName: "Hacker News · alice",
        title: "First Title",
        description: "First description",
        publishedAt: "2026-09-01T00:00:00.000Z",
        tags: ["Hacker News"],
        score: 99, // mutable field changed
        commentCount: 15,
        url: "https://example.com/test-1",
      },
    ]);

    const after = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:repo:1'`);

    expect(after).toHaveLength(1);
    expect(after[0].score).toBe(99);
    expect(after[0].commentCount).toBe(15);
    expect(after[0].lastSeenAt.getTime()).toBeGreaterThan(lastSeenBefore);
    // published_at (source truth) must not be replaced by ingestion time.
    expect(after[0].publishedAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("batches multiple distinct items into one upsert call", async () => {
    await repo.upsertFeedItems([
      {
        id: "test:repo:2",
        sourceType: "paper",
        sourceName: "arXiv",
        title: "Paper A",
        description: "Abstract A",
        publishedAt: "2026-09-02T00:00:00.000Z",
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-2",
      },
      {
        id: "test:repo:3",
        sourceType: "github",
        sourceName: "GitHub",
        title: "owner/repo",
        description: "A repo",
        publishedAt: "2026-09-03T00:00:00.000Z",
        tags: ["ai"],
        score: 0,
        commentCount: 0,
        url: "https://example.com/test-3",
        repositoryFullName: "owner/repo",
        owner: "owner",
        stars: 5,
        forks: 1,
      },
    ]);

    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key in ('test:repo:2', 'test:repo:3')`);

    expect(rows).toHaveLength(2);
  });

  it("preserves distinct rows for the same canonical_url across sources (no cross-source collapse)", async () => {
    await repo.upsertFeedItems([
      {
        id: "test:repo:rss:shared",
        sourceType: "news",
        sourceName: "OpenAI",
        title: "Shared Article",
        description: "Publisher original",
        publishedAt: "2026-09-04T00:00:00.000Z",
        tags: [],
        score: 0,
        commentCount: 0,
        url: "https://example.com/shared-article",
      },
      {
        id: "test:repo:hn:shared",
        sourceType: "hackernews",
        sourceName: "Hacker News · bob",
        title: "Shared Article (HN discussion)",
        description: "Discussion thread on Hacker News.",
        publishedAt: "2026-09-04T01:00:00.000Z",
        tags: ["Hacker News"],
        score: 50,
        commentCount: 20,
        url: "https://example.com/shared-article",
      },
    ]);

    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`canonical_url = 'https://example.com/shared-article'`);

    expect(rows).toHaveLength(2);
  });

  it("getRecentFeedItems returns previously persisted rows even without a new fetch", async () => {
    const items = await repo.getRecentFeedItems({ sourceType: "hackernews", limit: 500 });
    expect(items.some((item) => item.id === "test:repo:1")).toBe(true);
  });

  it("getRecentFeedItems filters by sourceType", async () => {
    const items = await repo.getRecentFeedItems({ sourceType: "github", limit: 500 });
    expect(items.every((item) => item.sourceType === "github")).toBe(true);
    expect(items.some((item) => item.id === "test:repo:3")).toBe(true);
  });
});

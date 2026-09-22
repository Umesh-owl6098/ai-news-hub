import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, inArray, eq } from "drizzle-orm";
import type { FeedItem } from "@/types/feed";
import type { RssFeedResult } from "@/lib/sources/rss";
import { RSS_SOURCES } from "@/data/rssSources";

/**
 * Integration tests for `refreshAllSources` (Step 21) against a real
 * PostgreSQL instance. Every test injects fake `SourceFetchers` — zero
 * real network/AI calls, per Step 21 §11 — while still exercising the
 * real upsert + source_health persistence path.
 *
 * Ownership note: `refreshAllSources` always writes to the real, fixed
 * source identities ("hackernews", "arxiv", "github", "rss:<id>") by
 * design (Step 21 §5 — stable identities, not a test-scoped variant).
 * That means this suite's own rows for those keys are NOT test-owned in
 * the usual "test:%" sense. Rather than delete them (which would nuke
 * real ingestion health if this ever ran against a DB with real refresh
 * history), this file snapshots their exact prior state in beforeAll and
 * restores it in afterAll — the same "leave it exactly as you found it"
 * discipline `feed_items`-prefix cleanup enforces for owned rows.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REAL_SOURCE_KEYS = ["hackernews", "arxiv", "github", ...RSS_SOURCES.map((s) => `rss:${s.id}`)];

function makeItem(id: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    sourceType: "hackernews",
    sourceName: "Test",
    title: `Title for ${id}`,
    description: "Description",
    publishedAt: "2026-09-10T00:00:00.000Z",
    tags: [],
    score: 1,
    commentCount: 0,
    url: `https://example.com/${id}`,
    ...overrides,
  };
}

function emptyRss(): RssFeedResult {
  return { items: [], failedSourceNames: [] };
}

describeIfDb("refreshAllSources (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let schema: typeof import("@/db/schema");
  let refreshService: typeof import("@/lib/refreshService");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalHealthRows: Map<string, any>;

  beforeAll(async () => {
    db = await import("@/db");
    schema = await import("@/db/schema");
    refreshService = await import("@/lib/refreshService");

    const rows = await db
      .getDb()!
      .select()
      .from(schema.sourceHealth)
      .where(inArray(schema.sourceHealth.sourceKey, REAL_SOURCE_KEYS));
    originalHealthRows = new Map(rows.map((r) => [r.sourceKey, r]));

    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'test:refresh:%'`);
  });

  afterAll(async () => {
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'test:refresh:%'`);

    for (const key of REAL_SOURCE_KEYS) {
      const original = originalHealthRows.get(key);
      if (original) {
        await db
          .getDb()!
          .update(schema.sourceHealth)
          .set({
            sourceLabel: original.sourceLabel,
            lastAttemptedAt: original.lastAttemptedAt,
            lastSucceededAt: original.lastSucceededAt,
            lastSuccessItemCount: original.lastSuccessItemCount,
            lastStatus: original.lastStatus,
            lastErrorCategory: original.lastErrorCategory,
            lastErrorMessage: original.lastErrorMessage,
            updatedAt: original.updatedAt,
          })
          .where(eq(schema.sourceHealth.sourceKey, key));
      } else {
        await db.getDb()!.execute(sql`delete from source_health where source_key = ${key}`);
      }
    }
  });

  it("records a success outcome per simple source and persists its items", async () => {
    const summary = await refreshService.refreshAllSources({
      fetchHackerNews: async () => [makeItem("test:refresh:hn:1", { sourceType: "hackernews" })],
      fetchArxiv: async () => [],
      fetchGithub: async () => [],
      fetchRss: async () => emptyRss(),
    });

    const hn = summary.outcomes.find((o) => o.sourceKey === "hackernews");
    expect(hn?.status).toBe("success");
    expect(hn?.itemCount).toBe(1);

    const [row] = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:refresh:hn:1'`);
    expect(row).toBeDefined();
  });

  it("isolates a single simple-source failure without affecting the others", async () => {
    const summary = await refreshService.refreshAllSources({
      fetchHackerNews: async () => {
        throw new Error("network error: connection reset");
      },
      fetchArxiv: async () => [makeItem("test:refresh:arxiv:1", { sourceType: "paper" })],
      fetchGithub: async () => [makeItem("test:refresh:github:1", { sourceType: "github" })],
      fetchRss: async () => emptyRss(),
    });

    const hn = summary.outcomes.find((o) => o.sourceKey === "hackernews");
    const arxiv = summary.outcomes.find((o) => o.sourceKey === "arxiv");
    const github = summary.outcomes.find((o) => o.sourceKey === "github");

    expect(hn?.status).toBe("failed");
    expect(hn?.errorCategory).toBe("network_error");
    expect(arxiv?.status).toBe("success");
    expect(github?.status).toBe("success");
  });

  it("does not delete previously-persisted items when a source subsequently fails", async () => {
    await refreshService.refreshAllSources({
      fetchHackerNews: async () => [makeItem("test:refresh:hn:survivor", { sourceType: "hackernews" })],
      fetchArxiv: async () => [],
      fetchGithub: async () => [],
      fetchRss: async () => emptyRss(),
    });

    let rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:refresh:hn:survivor'`);
    expect(rows).toHaveLength(1);

    await refreshService.refreshAllSources({
      fetchHackerNews: async () => {
        throw new Error("network error: boom");
      },
      fetchArxiv: async () => [],
      fetchGithub: async () => [],
      fetchRss: async () => emptyRss(),
    });

    rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:refresh:hn:survivor'`);
    expect(rows).toHaveLength(1);
  });

  it("is idempotent: an identical second refresh upserts in place, no duplicates", async () => {
    const fetchers = {
      fetchHackerNews: async () => [] as FeedItem[],
      fetchArxiv: async () => [makeItem("test:refresh:idempotent", { sourceType: "paper", score: 5 })],
      fetchGithub: async () => [] as FeedItem[],
      fetchRss: async () => emptyRss(),
    };

    await refreshService.refreshAllSources(fetchers);
    await refreshService.refreshAllSources(fetchers);

    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:refresh:idempotent'`);
    expect(rows).toHaveLength(1);
  });

  it("changed upstream metadata updates the existing row rather than inserting a second one", async () => {
    await refreshService.refreshAllSources({
      fetchHackerNews: async () => [] as FeedItem[],
      fetchArxiv: async () => [makeItem("test:refresh:mutate", { sourceType: "paper", score: 1 })],
      fetchGithub: async () => [] as FeedItem[],
      fetchRss: async () => emptyRss(),
    });
    await refreshService.refreshAllSources({
      fetchHackerNews: async () => [] as FeedItem[],
      fetchArxiv: async () => [makeItem("test:refresh:mutate", { sourceType: "paper", score: 99 })],
      fetchGithub: async () => [] as FeedItem[],
      fetchRss: async () => emptyRss(),
    });

    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:refresh:mutate'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(99);
  });

  it("reports honest partial success across RSS publishers and only persists the successful ones", async () => {
    const [openai, huggingface] = RSS_SOURCES;
    const rssResult: RssFeedResult = {
      items: [
        makeItem("test:refresh:rss:openai:1", { sourceType: "news", sourceId: openai.id }),
        makeItem("test:refresh:rss:hf:1", { sourceType: "news", sourceId: huggingface.id }),
      ],
      // Step 25: RSS_SOURCES now has more than 4 entries — slice(2) fails
      // "the rest" (deepmind, google-research, and whatever Step 25 added),
      // not just two. The assertions below only check the specific named
      // outcomes that matter for this test, so this stays correct however
      // many publishers exist.
      failedSourceNames: RSS_SOURCES.slice(2).map((s) => s.name),
    };

    const summary = await refreshService.refreshAllSources({
      fetchHackerNews: async () => [],
      fetchArxiv: async () => [],
      fetchGithub: async () => [],
      fetchRss: async () => rssResult,
    });

    const rssOutcomes = summary.outcomes.filter((o) => o.sourceKey.startsWith("rss:"));
    expect(rssOutcomes).toHaveLength(RSS_SOURCES.length);

    const openaiOutcome = rssOutcomes.find((o) => o.sourceKey === "rss:openai");
    const hfOutcome = rssOutcomes.find((o) => o.sourceKey === "rss:huggingface");
    const deepmindOutcome = rssOutcomes.find((o) => o.sourceKey === "rss:deepmind");
    const googleOutcome = rssOutcomes.find((o) => o.sourceKey === "rss:google-research");

    expect(openaiOutcome?.status).toBe("success");
    expect(openaiOutcome?.itemCount).toBe(1);
    expect(hfOutcome?.status).toBe("success");
    expect(deepmindOutcome?.status).toBe("failed");
    expect(googleOutcome?.status).toBe("failed");

    const persisted = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key in ('test:refresh:rss:openai:1', 'test:refresh:rss:hf:1')`);
    expect(persisted).toHaveLength(2);
  });

  it("gives every configured RSS publisher its own health row rather than collapsing them into one", async () => {
    await refreshService.refreshAllSources({
      fetchHackerNews: async () => [],
      fetchArxiv: async () => [],
      fetchGithub: async () => [],
      fetchRss: async () => emptyRss(),
    });

    const rows = await db
      .getDb()!
      .select()
      .from(schema.sourceHealth)
      .where(sql`source_key like 'rss:%'`);
    const keys = rows.map((r) => r.sourceKey).sort();
    expect(keys).toEqual(RSS_SOURCES.map((s) => `rss:${s.id}`).sort());
  });

  it("sanitizes a secret-looking error message before it is ever persisted", async () => {
    await refreshService.refreshAllSources({
      fetchHackerNews: async () => [],
      fetchArxiv: async () => [],
      fetchGithub: async () => {
        throw new Error("request failed (401): Authorization: Bearer sk-super-secret-token-value");
      },
      fetchRss: async () => emptyRss(),
    });

    const [row] = await db
      .getDb()!
      .select()
      .from(schema.sourceHealth)
      .where(sql`source_key = 'github'`);

    expect(row.lastErrorMessage).not.toContain("sk-super-secret-token-value");
    expect(row.lastErrorMessage).toContain("[redacted]");
  });

  it("two overlapping refresh calls share one in-flight run instead of racing a duplicate", async () => {
    let resolveFetch: (items: FeedItem[]) => void;
    const pending = new Promise<FeedItem[]>((resolve) => {
      resolveFetch = resolve;
    });

    const fetchers = {
      fetchHackerNews: () => pending,
      fetchArxiv: async () => [] as FeedItem[],
      fetchGithub: async () => [] as FeedItem[],
      fetchRss: async () => emptyRss(),
    };

    expect(refreshService.isRefreshInFlight()).toBe(false);
    const call1 = refreshService.refreshAllSources(fetchers);
    expect(refreshService.isRefreshInFlight()).toBe(true);
    const call2 = refreshService.refreshAllSources(fetchers);

    resolveFetch!([makeItem("test:refresh:overlap:1", { sourceType: "hackernews" })]);
    const [summary1, summary2] = await Promise.all([call1, call2]);

    // Same in-flight promise, so both callers observe the identical
    // resolved result object, not two independently-run refreshes.
    expect(summary1).toBe(summary2);
    expect(refreshService.isRefreshInFlight()).toBe(false);

    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:refresh:overlap:1'`);
    expect(rows).toHaveLength(1);
  });

  it("leaves existing bookmarks untouched by a refresh (no unintended coupling)", async () => {
    await refreshService.refreshAllSources({
      fetchHackerNews: async () => [makeItem("test:refresh:bookmarked", { sourceType: "hackernews", score: 1 })],
      fetchArxiv: async () => [],
      fetchGithub: async () => [],
      fetchRss: async () => emptyRss(),
    });

    const [item] = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = 'test:refresh:bookmarked'`);

    await db.getDb()!.insert(schema.bookmarks).values({ feedItemId: item.id }).onConflictDoNothing();

    // A subsequent refresh that no longer even mentions this item must not
    // touch the bookmark row (refreshAllSources never writes to bookmarks).
    await refreshService.refreshAllSources({
      fetchHackerNews: async () => [],
      fetchArxiv: async () => [],
      fetchGithub: async () => [],
      fetchRss: async () => emptyRss(),
    });

    const bookmarkRows = await db
      .getDb()!
      .select()
      .from(schema.bookmarks)
      .where(sql`feed_item_id = ${item.id}`);
    expect(bookmarkRows).toHaveLength(1);

    await db.getDb()!.delete(schema.bookmarks).where(sql`feed_item_id = ${item.id}`);
  });
});

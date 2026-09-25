import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { FeedItem } from "@/types/feed";

/**
 * Integration tests against a real PostgreSQL instance. Skipped entirely
 * unless DATABASE_URL is set. Search ranking and full-text matching cannot
 * be meaningfully verified against a mock — they depend on real Postgres
 * FTS behavior (websearch_to_tsquery, ts_rank_cd, the GIN index).
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

function testItem(sourceKey: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: sourceKey,
    sourceType: "hackernews",
    sourceName: "Hacker News",
    title: "Untitled",
    description: "No summary.",
    publishedAt: "2026-09-01T00:00:00.000Z",
    tags: [],
    score: 0,
    commentCount: 0,
    url: `https://example.com/${sourceKey.replace(/[^a-z0-9]/gi, "-")}`,
    ...overrides,
  };
}

describeIfDb("searchFeedItems (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like 'searchtest:%'
    )`);
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'searchtest:%'`);

    // A small, deliberately varied fixture set covering every field the
    // search vector indexes and every filter combination under test.
    await repo.upsertFeedItems([
      testItem("searchtest:title-match", {
        title: "Building AI Agents with LLMs",
        description: "A short, unrelated summary about gardening.",
        publishedAt: "2026-09-05T00:00:00.000Z",
      }),
      testItem("searchtest:summary-match", {
        title: "Completely Unrelated Headline",
        description: "This article is actually about AI agents and how they plan tasks.",
        publishedAt: "2026-09-04T00:00:00.000Z",
      }),
      testItem("searchtest:tag-match", {
        title: "A Generic Roundup",
        description: "Nothing special here.",
        tags: ["agents", "open-source"],
        publishedAt: "2026-09-03T00:00:00.000Z",
      }),
      testItem("searchtest:author-match", {
        sourceType: "paper",
        title: "An Unrelated Paper Title",
        description: "An abstract about something else entirely.",
        authors: ["Ada Agents-Smith"],
        publishedAt: "2026-09-02T00:00:00.000Z",
      }),
      testItem("searchtest:repo-match", {
        sourceType: "github",
        title: "some-project",
        description: "A generic repository.",
        repositoryFullName: "example/agents-toolkit",
        owner: "example",
        publishedAt: "2026-09-06T00:00:00.000Z",
      }),
      testItem("searchtest:source-name-match", {
        sourceType: "news",
        // Step 24: deliberately NOT one of the app's real configured RSS
        // publishers (e.g. "OpenAI") — the real corpus legitimately
        // contains dozens of genuine matches for that exact name, which
        // made this fixture indistinguishable from real production
        // content in a query for it. A fabricated, source-key-shaped
        // name exercises the same source_name-field-indexing behavior
        // without any risk of colliding with real data, now or later.
        sourceId: "searchtest-publisher",
        sourceName: "Searchtestia Publishing",
        title: "A Completely Different Headline",
        description: "Nothing about the search term here.",
        publishedAt: "2026-09-07T00:00:00.000Z",
      }),
      testItem("searchtest:no-match", {
        title: "Totally Unrelated To Anything",
        description: "Gardening tips for beginners.",
        publishedAt: "2026-08-01T00:00:00.000Z",
      }),
      // Ranking fixtures: one item where the query word is in the title
      // (should rank highest), one where it's buried in the summary only.
      testItem("searchtest:rank-title", {
        title: "Transformer Architecture Explained",
        description: "A deep dive into neural network design choices.",
        publishedAt: "2026-01-01T00:00:00.000Z", // deliberately old — relevance must still win
      }),
      testItem("searchtest:rank-summary", {
        title: "Weekly Roundup of Unrelated News",
        description: "Also, briefly, a transformer was mentioned once in passing.",
        publishedAt: "2026-09-08T00:00:00.000Z", // deliberately recent — must not out-rank the title match
      }),
      // Tie-breaking fixtures: identical publishedAt, must order by id desc deterministically.
      testItem("searchtest:tie-a", {
        title: "Tie Breaker Item Alpha",
        publishedAt: "2026-09-01T12:00:00.000Z",
      }),
      testItem("searchtest:tie-b", {
        title: "Tie Breaker Item Beta",
        publishedAt: "2026-09-01T12:00:00.000Z",
      }),
      // Time-range fixtures.
      testItem("searchtest:recent", {
        title: "Recent Agents Update",
        publishedAt: new Date().toISOString(),
      }),
      testItem("searchtest:old", {
        title: "Old Agents Update",
        publishedAt: "2020-01-01T00:00:00.000Z",
      }),
      // Cross-source dedup fixture: same canonical URL, two sources.
      testItem("searchtest:dedup:rss", {
        sourceType: "news",
        sourceId: "openai",
        sourceName: "OpenAI",
        title: "Shared Dedup Agents Article",
        url: "https://example.com/shared-dedup-agents-article",
        publishedAt: "2026-09-08T00:00:00.000Z",
      }),
      testItem("searchtest:dedup:hn", {
        sourceType: "hackernews",
        title: "Shared Dedup Agents Article (HN)",
        url: "https://example.com/shared-dedup-agents-article",
        publishedAt: "2026-09-08T01:00:00.000Z",
      }),
      // Step 27: three items sharing one publisher, for pagination-within-
      // a-publisher-filter tests below.
      testItem("searchtest:pubpage:1", {
        sourceType: "news",
        sourceId: "searchtest-pubpage",
        sourceName: "Searchtestia Publishing",
        title: "Publisher Pagination Fixture One",
        publishedAt: "2026-09-10T03:00:00.000Z",
      }),
      testItem("searchtest:pubpage:2", {
        sourceType: "news",
        sourceId: "searchtest-pubpage",
        sourceName: "Searchtestia Publishing",
        title: "Publisher Pagination Fixture Two",
        publishedAt: "2026-09-10T02:00:00.000Z",
      }),
      testItem("searchtest:pubpage:3", {
        sourceType: "news",
        sourceId: "searchtest-pubpage",
        sourceName: "Searchtestia Publishing",
        title: "Publisher Pagination Fixture Three",
        publishedAt: "2026-09-10T01:00:00.000Z",
      }),
      // Ordering fixtures: a unique token ("zebracorn") that no real row can
      // contain, so an unscoped (All) query returns exactly these three.
      // Newest-first (hn, news, paper), best-match-first (paper, hn, news)
      // and the old dedup's source-priority order (news, paper, hn) are all
      // three different orders, so a regression can't pass by coincidence.
      testItem("searchtest:order:hn", {
        sourceType: "hackernews",
        title: "Zebracorn Discussion Thread",
        description: "Hacker News thread.",
        publishedAt: "2026-09-10T05:00:00.000Z",
      }),
      testItem("searchtest:order:news", {
        sourceType: "news",
        sourceId: "searchtest-order",
        sourceName: "Searchtestia Ordering",
        title: "Announcement Of Something",
        description: "A publisher post that mentions zebracorn once.",
        publishedAt: "2026-09-10T04:00:00.000Z",
      }),
      testItem("searchtest:order:paper", {
        sourceType: "paper",
        title: "Zebracorn Zebracorn Zebracorn Study",
        description: "Zebracorn abstract.",
        publishedAt: "2026-09-10T03:00:00.000Z",
      }),
    ]);

    await repo.addBookmark("searchtest:title-match");
  });

  afterAll(async () => {
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like 'searchtest:%'
    )`);
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'searchtest:%'`);
  });

  // Scope every assertion to the searchtest:* fixtures so unrelated rows
  // from other test files/dev usage never leak into result counts.
  function ids(items: FeedItem[]): string[] {
    return items.filter((item) => item.id.startsWith("searchtest:")).map((item) => item.id);
  }

  it("matches on title", async () => {
    // Step 24: a bare "agents" query is no longer a safely fixture-only
    // term — the real corpus now legitimately contains dozens of matches
    // (richer, uncapped GitHub topics; see Step 24's field-loss fixes),
    // which can rank/limit the small fixture out of the result window.
    // The 3-word AND query is still guaranteed to match the fixture
    // (it's a verbatim prefix of the fixture title) while being far less
    // likely to coincidentally match unrelated real content.
    const { items } = await repo.searchFeedItems({ query: "Building AI Agents" });
    expect(ids(items)).toContain("searchtest:title-match");
  });

  it("matches on summary", async () => {
    const { items } = await repo.searchFeedItems({ query: "plan tasks" });
    expect(ids(items)).toContain("searchtest:summary-match");
  });

  it("matches on tags", async () => {
    const { items } = await repo.searchFeedItems({ query: "open-source" });
    expect(ids(items)).toContain("searchtest:tag-match");
  });

  it("matches on authors", async () => {
    const { items } = await repo.searchFeedItems({ query: "Ada Agents-Smith" });
    expect(ids(items)).toContain("searchtest:author-match");
  });

  it("matches on repository full name", async () => {
    const { items } = await repo.searchFeedItems({ query: "agents-toolkit" });
    expect(ids(items)).toContain("searchtest:repo-match");
  });

  it("matches on source name", async () => {
    const { items } = await repo.searchFeedItems({ query: "Searchtestia" });
    expect(ids(items)).toContain("searchtest:source-name-match");
  });

  it("handles a multi-word query", async () => {
    const { items } = await repo.searchFeedItems({ query: "building agents" });
    expect(ids(items)).toContain("searchtest:title-match");
  });

  it("supports a quoted phrase", async () => {
    const { items } = await repo.searchFeedItems({ query: '"building ai agents"' });
    expect(ids(items)).toContain("searchtest:title-match");
  });

  it("returns no matches for an unrelated query, without erroring", async () => {
    const { items, total } = await repo.searchFeedItems({ query: "xyzzy-nonexistent-term-qqq" });
    expect(ids(items)).not.toContain("searchtest:no-match");
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it("normalizes case", async () => {
    const lower = await repo.searchFeedItems({ query: "transformer" });
    const upper = await repo.searchFeedItems({ query: "TRANSFORMER" });
    expect(ids(lower.items).sort()).toEqual(ids(upper.items).sort());
  });

  it("tolerates a punctuation-heavy query without throwing", async () => {
    await expect(repo.searchFeedItems({ query: "agents!!! @@@ ###" })).resolves.toBeDefined();
  });

  it("tolerates malformed/strange input (unbalanced quotes, bare operators) without a SQL error", async () => {
    const weirdInputs = ['"unbalanced quote', "AND OR NOT", "()()", "--", "'; DROP TABLE feed_items; --", "a".repeat(500)];
    for (const query of weirdInputs) {
      await expect(repo.searchFeedItems({ query })).resolves.toBeDefined();
    }
    // And the table must still exist and be queryable afterward.
    const { total } = await repo.searchFeedItems({ query: "agents" });
    expect(total).toBeGreaterThan(0);
  });

  it("bounds the result count to the requested limit", async () => {
    const { items } = await repo.searchFeedItems({ limit: 3 });
    expect(items.length).toBeLessThanOrEqual(3);
  });

  it("clamps an excessive limit to the repository's hard cap", async () => {
    const { items } = await repo.searchFeedItems({ limit: 10_000 });
    expect(items.length).toBeLessThanOrEqual(50);
  });

  // --- Ranking -----------------------------------------------------------

  it("ranks a title match above a weak summary-only match, ignoring recency", async () => {
    const { items } = await repo.searchFeedItems({ query: "transformer", sort: "relevance" });
    const filtered = items.filter((i) => i.id.startsWith("searchtest:rank-"));
    expect(filtered[0]?.id).toBe("searchtest:rank-title");
  });

  it("'newest' sort ignores relevance ordering", async () => {
    const { items } = await repo.searchFeedItems({ query: "transformer", sort: "newest" });
    const filtered = items.filter((i) => i.id.startsWith("searchtest:rank-"));
    // The more recent (but weaker-relevance) item must come first under "newest".
    expect(filtered[0]?.id).toBe("searchtest:rank-summary");
  });

  it("breaks ties deterministically (identical published_at) by id descending", async () => {
    const { items } = await repo.searchFeedItems({ query: "tie breaker" });
    const filtered = items.filter((i) => i.id.startsWith("searchtest:tie-"));
    expect(filtered.map((i) => i.id)).toEqual(["searchtest:tie-b", "searchtest:tie-a"]);
  });

  // --- Filters -------------------------------------------------------------

  it("query + source filters to that publisher only", async () => {
    const { items } = await repo.searchFeedItems({ query: "headline", sourceId: "openai" });
    expect(items.every((i) => i.sourceId === "openai")).toBe(true);
  });

  it("query + time excludes items outside the window", async () => {
    const { items } = await repo.searchFeedItems({ query: "agents update", sinceDays: 1 });
    const filtered = ids(items);
    expect(filtered).toContain("searchtest:recent");
    expect(filtered).not.toContain("searchtest:old");
  });

  it("query + bookmarked restricts to bookmarked items", async () => {
    const { items } = await repo.searchFeedItems({ query: "agents", bookmarkedOnly: true });
    expect(ids(items)).toEqual(["searchtest:title-match"]);
  });

  it("query + source + time combine correctly", async () => {
    const { items } = await repo.searchFeedItems({ query: "headline", sourceId: "openai", sinceDays: 30 });
    expect(items.every((i) => i.sourceId === "openai")).toBe(true);
  });

  it("source filter works without a query", async () => {
    const { items } = await repo.searchFeedItems({ sourceType: "github" });
    expect(items.every((i) => i.sourceType === "github")).toBe(true);
    expect(ids(items)).toContain("searchtest:repo-match");
  });

  it("bookmarked filter works without a query", async () => {
    const { items } = await repo.searchFeedItems({ bookmarkedOnly: true });
    expect(ids(items)).toEqual(["searchtest:title-match"]);
  });

  // --- Step 27: publisher (sourceId) combined with every other filter ------

  it("sourceType + sourceId combine correctly (source type AND publisher both apply)", async () => {
    // Explicit max limit — the real corpus can independently accumulate
    // >24 (the default page size) genuine "openai" news items over time,
    // which would otherwise push this older fixture off the default page.
    const { items } = await repo.searchFeedItems({ sourceType: "news", sourceId: "openai", limit: 50 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.sourceType === "news" && i.sourceId === "openai")).toBe(true);
    expect(ids(items)).toContain("searchtest:dedup:rss");
  });

  it("an impossible sourceType + sourceId combination returns zero results, not an error", async () => {
    // "openai" never appears as sourceType "paper" in this corpus.
    const { items, total } = await repo.searchFeedItems({ sourceType: "paper", sourceId: "openai" });
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });

  it("publisher filter + pagination: offset/limit slice the same publisher's results without overlap or gaps", async () => {
    const firstPage = await repo.searchFeedItems({ sourceId: "searchtest-pubpage", sort: "newest", limit: 2, offset: 0 });
    const secondPage = await repo.searchFeedItems({ sourceId: "searchtest-pubpage", sort: "newest", limit: 2, offset: 2 });

    expect(ids(firstPage.items)).toEqual(["searchtest:pubpage:1", "searchtest:pubpage:2"]);
    expect(ids(secondPage.items)).toEqual(["searchtest:pubpage:3"]);
    // total reflects the full matching set regardless of the page requested.
    expect(firstPage.total).toBeGreaterThanOrEqual(3);
    expect(firstPage.total).toBe(secondPage.total);
  });

  it("publisher + bookmarked filter combine correctly", async () => {
    // Scoped add/remove around just this test, rather than a shared
    // beforeAll bookmark, so it never changes what "bookmarked filter
    // works without a query" (above) sees.
    await repo.addBookmark("searchtest:pubpage:2");
    try {
      const { items } = await repo.searchFeedItems({ sourceId: "searchtest-pubpage", bookmarkedOnly: true });
      expect(ids(items)).toEqual(["searchtest:pubpage:2"]);
    } finally {
      await repo.removeBookmark("searchtest:pubpage:2");
    }
  });

  // --- Deduplication -------------------------------------------------------

  it("dedupes the same canonical URL across sources in the unscoped (All) search", async () => {
    const { items } = await repo.searchFeedItems({ query: "shared dedup agents" });
    const matches = ids(items).filter((id) => id.startsWith("searchtest:dedup:"));
    expect(matches).toHaveLength(1);
    // The RSS/publisher original wins over the HN submission (Step 8 §14).
    expect(matches[0]).toBe("searchtest:dedup:rss");
  });

  it("does not dedupe when scoped to a specific sourceType (Hacker News tab)", async () => {
    const { items } = await repo.searchFeedItems({ query: "shared dedup agents", sourceType: "hackernews" });
    expect(ids(items)).toContain("searchtest:dedup:hn");
  });

  it("never deletes the underlying rows — both dedup fixtures still exist in the table", async () => {
    const rows = await db
      .getDb()!
      .select()
      .from((await import("@/db/schema")).feedItems)
      .where(sql`source_key in ('searchtest:dedup:rss', 'searchtest:dedup:hn')`);
    expect(rows).toHaveLength(2);
  });
  // --- Ordering survives cross-source dedup ---------------------------------
  //
  // Regression: the unscoped (All) search returned SQL-ordered rows, then
  // dedupeFeedItems re-sorted them by source priority, so "Newest" (and
  // Relevance) came back grouped news-first instead of in the requested order.

  const ORDER_QUERY = "zebracorn";
  const orderIds = (items: FeedItem[]) => items.map((i) => i.id).filter((id) => id.startsWith("searchtest:order:"));

  it("All search, Newest: results are strictly descending by publication date across source types", async () => {
    const { items } = await repo.searchFeedItems({ query: ORDER_QUERY, sort: "newest" });
    expect(orderIds(items)).toEqual([
      "searchtest:order:hn", // 05:00
      "searchtest:order:news", // 04:00
      "searchtest:order:paper", // 03:00
    ]);
    const times = items.map((i) => new Date(i.publishedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("All search, Relevance: post-dedup order equals the ranking order SQL returned before dedup", async () => {
    const { items } = await repo.searchFeedItems({ query: ORDER_QUERY, sort: "relevance" });

    // Same ORDER BY the repository uses, run directly against the table —
    // i.e. the order before any in-memory dedup step touches it.
    const expected = await db.getDb()!.execute<{ source_key: string }>(sql`
      select source_key from feed_items
      where search_vector @@ websearch_to_tsquery('english', ${ORDER_QUERY})
      order by ts_rank_cd(search_vector, websearch_to_tsquery('english', ${ORDER_QUERY})) desc,
               published_at desc, id desc
    `);
    const expectedIds = [...expected].map((r) => r.source_key);

    expect(expectedIds).toHaveLength(3);
    expect(orderIds(items)).toEqual(expectedIds);
  });

  it("the ordering fixtures are a meaningful test: Newest, Relevance and source-priority are three different orders", async () => {
    const priorityOrder = ["searchtest:order:news", "searchtest:order:paper", "searchtest:order:hn"];
    const newest = orderIds((await repo.searchFeedItems({ query: ORDER_QUERY, sort: "newest" })).items);
    const relevance = orderIds((await repo.searchFeedItems({ query: ORDER_QUERY, sort: "relevance" })).items);
    expect(newest).not.toEqual(priorityOrder);
    expect(relevance).not.toEqual(priorityOrder);
    expect(newest).not.toEqual(relevance);
  });

  it("dedup still picks the same duplicate winner in All search (publisher over HN) while preserving order", async () => {
    const { items } = await repo.searchFeedItems({ query: "shared dedup agents", sort: "newest" });
    const matches = ids(items).filter((id) => id.startsWith("searchtest:dedup:"));
    expect(matches).toEqual(["searchtest:dedup:rss"]);
  });
});

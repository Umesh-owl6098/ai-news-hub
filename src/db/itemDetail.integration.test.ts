import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

/**
 * Step 19 — integration tests for the `/item/[id]` detail page's data
 * layer: `getFeedItemById`, `getRelatedFeedItems`, and the existing
 * enrichment/bookmark functions as exercised through a detail-page-shaped
 * flow. Skipped entirely unless DATABASE_URL is set. Never calls a real
 * embedding provider or a real AI provider — every embedding here uses the
 * deterministic mock provider (mockEmbeddingProvider.ts), and enrichment
 * uses the deterministic mock provider (mockProvider.ts), so this suite has
 * zero network/API cost.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const TEST_SOURCE_KEY_PREFIX = "itemdetailtest:";

describeIfDb("Item detail page data layer (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let enrichmentService: typeof import("@/lib/ai/enrichmentService");
  let mockProviderModule: typeof import("@/lib/ai/mockProvider");
  let mockEmbeddingModule: typeof import("@/lib/ai/mockEmbeddingProvider");
  let semanticDocumentModule: typeof import("@/lib/ai/semanticDocument");
  let bookmarksActions: typeof import("@/app/actions/bookmarks");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    enrichmentService = await import("@/lib/ai/enrichmentService");
    mockProviderModule = await import("@/lib/ai/mockProvider");
    mockEmbeddingModule = await import("@/lib/ai/mockEmbeddingProvider");
    semanticDocumentModule = await import("@/lib/ai/semanticDocument");
    bookmarksActions = await import("@/app/actions/bookmarks");
  });

  async function cleanup() {
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like ${TEST_SOURCE_KEY_PREFIX + "%"}
    )`);
    await db.getDb()!.execute(sql`delete from feed_items where source_key like ${TEST_SOURCE_KEY_PREFIX + "%"}`);
  }
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(cleanup);

  let counter = 0;
  async function seedItem(overrides: Partial<Parameters<typeof repo.upsertFeedItems>[0][0]> = {}) {
    counter++;
    const id = overrides.id ?? `${TEST_SOURCE_KEY_PREFIX}${counter}`;
    await repo.upsertFeedItems([
      {
        sourceType: "hackernews",
        sourceName: "Hacker News",
        title: `Detail test item ${counter}`,
        description: "A description with enough real content to embed meaningfully.",
        publishedAt: new Date(Date.now() - counter * 1000).toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: `https://example.com/itemdetailtest-${counter}`,
        ...overrides,
        id,
      },
    ]);
    const found = await repo.getFeedItemForEnrichment(id);
    if (!found) throw new Error("test setup failed");
    return { sourceKey: id, feedItemId: found.feedItemId };
  }

  async function embedItem(feedItemId: number, title: string, summary: string) {
    const provider = mockEmbeddingModule.createMockEmbeddingProvider();
    const document = semanticDocumentModule.toSemanticDocument({
      title,
      summary,
      sourceType: "hackernews",
      sourceName: "Hacker News",
      tags: null,
      authors: null,
      repositoryFullName: null,
    });
    const { embeddings } = await provider.embed([document]);
    await repo.upsertFeedItemEmbedding({
      feedItemId,
      provider: provider.name,
      model: provider.model,
      embeddingVersion: semanticDocumentModule.EMBEDDING_SCHEMA_VERSION,
      inputHash: `test-hash-${feedItemId}`,
      embedding: embeddings[0].embedding,
      dimensions: embeddings[0].dimensions,
    });
  }

  describe("getFeedItemById", () => {
    it("returns the full FeedItem, including the internal dbId, for a valid id", async () => {
      const { sourceKey, feedItemId } = await seedItem({
        title: "A specific detail-page test item",
        url: "https://example.com/specific-item",
      });

      const item = await repo.getFeedItemById(feedItemId);
      expect(item).not.toBeNull();
      expect(item!.id).toBe(sourceKey);
      expect(item!.dbId).toBe(feedItemId);
      expect(item!.title).toBe("A specific detail-page test item");
      expect(item!.url).toBe("https://example.com/specific-item");
    });

    it("returns null for a nonexistent id (the route's notFound() trigger)", async () => {
      const item = await repo.getFeedItemById(999_999_999);
      expect(item).toBeNull();
    });

    it("normalizes GitHub-specific fields (stars/forks/language/owner) when present", async () => {
      const { feedItemId } = await seedItem({
        sourceType: "github",
        sourceName: "GitHub",
        repositoryFullName: "test-owner/test-repo",
        owner: "test-owner",
        language: "TypeScript",
        stars: 4200,
        forks: 99,
      });

      const item = await repo.getFeedItemById(feedItemId);
      expect(item!.sourceType).toBe("github");
      expect(item!.repositoryFullName).toBe("test-owner/test-repo");
      expect(item!.owner).toBe("test-owner");
      expect(item!.language).toBe("TypeScript");
      expect(item!.stars).toBe(4200);
      expect(item!.forks).toBe(99);
    });

    it("normalizes arXiv-specific fields (authors/pdfUrl) when present", async () => {
      const { feedItemId } = await seedItem({
        sourceType: "paper",
        sourceName: "arXiv",
        authors: ["Ada Lovelace", "Alan Turing"],
        pdfUrl: "https://arxiv.org/pdf/0000.00000",
      });

      const item = await repo.getFeedItemById(feedItemId);
      expect(item!.sourceType).toBe("paper");
      expect(item!.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
      expect(item!.pdfUrl).toBe("https://arxiv.org/pdf/0000.00000");
    });

    it("normalizes Hacker News-specific fields (discussionUrl/score/commentCount) when present", async () => {
      const { feedItemId } = await seedItem({
        sourceType: "hackernews",
        sourceName: "Hacker News",
        discussionUrl: "https://news.ycombinator.com/item?id=1",
        score: 321,
        commentCount: 42,
      });

      const item = await repo.getFeedItemById(feedItemId);
      expect(item!.sourceType).toBe("hackernews");
      expect(item!.discussionUrl).toBe("https://news.ycombinator.com/item?id=1");
      expect(item!.score).toBe(321);
      expect(item!.commentCount).toBe(42);
    });

    it("normalizes RSS/news items to have none of the source-specific fields set", async () => {
      const { feedItemId } = await seedItem({ sourceType: "news", sourceName: "Some Publisher", sourceId: "some-publisher" });

      const item = await repo.getFeedItemById(feedItemId);
      expect(item!.sourceType).toBe("news");
      expect(item!.repositoryFullName).toBeUndefined();
      expect(item!.authors).toBeUndefined();
      expect(item!.discussionUrl).toBeUndefined();
      expect(item!.pdfUrl).toBeUndefined();
    });
  });

  describe("enrichment state (zero vs. legitimate)", () => {
    it("zero-enrichment: a fresh item has no enrichment row at all", async () => {
      const { feedItemId } = await seedItem();
      const enrichment = await repo.getEnrichmentByFeedItemId(feedItemId);
      expect(enrichment).toBeNull();
    });

    it("legitimate enrichment: a completed enrichment is retrievable with summary and topics", async () => {
      const { sourceKey, feedItemId } = await seedItem();
      const outcome = await enrichmentService.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
      expect(outcome.status).toBe("completed");

      const enrichment = await repo.getEnrichmentByFeedItemId(feedItemId);
      expect(enrichment?.status).toBe("completed");
      expect(enrichment?.summary).toBeTruthy();
      expect(enrichment?.topics?.length).toBeGreaterThan(0);
    });
  });

  describe("getRelatedFeedItems", () => {
    it("excludes the current item from its own related results", async () => {
      const a = await seedItem({ title: "Unique alpha topic beta gamma", description: "Shared distinctive content for embedding." });
      const b = await seedItem({ title: "Unique alpha topic delta epsilon", description: "Shared distinctive content for embedding." });
      await embedItem(a.feedItemId, "Unique alpha topic beta gamma", "Shared distinctive content for embedding.");
      await embedItem(b.feedItemId, "Unique alpha topic delta epsilon", "Shared distinctive content for embedding.");

      const related = await repo.getRelatedFeedItems(a.feedItemId, 6);
      expect(related.some((r) => r.feedItemId === a.feedItemId)).toBe(false);
      expect(related.some((r) => r.feedItemId === b.feedItemId)).toBe(true);
    });

    it("is bounded to the requested limit even with more candidates available", async () => {
      const target = await seedItem({ title: "Bounded result count anchor item" });
      await embedItem(target.feedItemId, "Bounded result count anchor item", target.sourceKey);
      for (let i = 0; i < 8; i++) {
        const other = await seedItem({ title: `Bounded result count neighbor ${i}` });
        await embedItem(other.feedItemId, `Bounded result count neighbor ${i}`, other.sourceKey);
      }

      const related = await repo.getRelatedFeedItems(target.feedItemId, 3);
      expect(related.length).toBeLessThanOrEqual(3);
    });

    it("falls back to lexical similarity when the current item has no stored embedding", async () => {
      // The lexical fallback queries with the target's ENTIRE title via
      // websearch_to_tsquery, which ANDs together every non-stopword term —
      // so the target's title is deliberately just the one distinctive word
      // itself, making the query a single-term match that `lexicalMatch`'s
      // longer title trivially satisfies by containing that same word.
      const distinctiveWord = `zzyzxqplorf${Date.now()}`;
      const target = await seedItem({ title: distinctiveWord });
      const lexicalMatch = await seedItem({ title: `An article discussing ${distinctiveWord} in depth` });

      // Deliberately no embedItem() call for `target` — this is the "no
      // stored embedding" branch by construction.
      const related = await repo.getRelatedFeedItems(target.feedItemId, 6);
      expect(related.some((r) => r.feedItemId === lexicalMatch.feedItemId)).toBe(true);
      expect(related.some((r) => r.feedItemId === target.feedItemId)).toBe(false);
    });

    it("omits gracefully (returns []) when neither an embedding nor a lexical match exists", async () => {
      const lonely = await seedItem({ title: `qqzxwvutsrqpnmlkjih${Date.now()}` });
      const related = await repo.getRelatedFeedItems(lonely.feedItemId, 6);
      expect(related).toEqual([]);
    });

    it("makes zero embedding-provider calls — reads only already-stored vectors", async () => {
      const a = await seedItem({ title: "Zero provider call check A" });
      const b = await seedItem({ title: "Zero provider call check B" });
      await embedItem(a.feedItemId, "Zero provider call check A", a.sourceKey);
      await embedItem(b.feedItemId, "Zero provider call check B", b.sourceKey);

      const openaiModule = await import("@/lib/ai/openaiEmbeddingProvider");
      const spy = vi.spyOn(openaiModule, "createOpenAiEmbeddingProvider");

      const related = await repo.getRelatedFeedItems(a.feedItemId, 6);

      expect(spy).not.toHaveBeenCalled();
      expect(related.some((r) => r.feedItemId === b.feedItemId)).toBe(true);
      spy.mockRestore();
    });
  });

  describe("bookmark behavior from the detail page", () => {
    it("adds and removes a bookmark via the same server actions the detail page's button calls", async () => {
      const { sourceKey } = await seedItem();

      const addResult = await bookmarksActions.addBookmarkAction(sourceKey);
      expect(addResult.ok).toBe(true);
      expect(await repo.getBookmarkedSourceKeys()).toContain(sourceKey);

      const removeResult = await bookmarksActions.removeBookmarkAction(sourceKey);
      expect(removeResult.ok).toBe(true);
      expect(await repo.getBookmarkedSourceKeys()).not.toContain(sourceKey);
    });
  });
});

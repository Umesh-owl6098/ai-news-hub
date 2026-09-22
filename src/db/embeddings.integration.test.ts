import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

/**
 * Step 17 — integration tests for semantic embeddings and retrieval
 * (schema, repository, service, and search layers together) against a
 * real PostgreSQL + pgvector instance. Skipped entirely unless
 * DATABASE_URL is set. Never calls a real embedding provider — every test
 * here uses the deterministic mock provider (mockEmbeddingProvider.ts),
 * so this suite has zero network/API cost and zero external network
 * dependency.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

// Every fixture this file creates uses this prefix, and every
// embedRecentItems/previewEmbeddingCandidates call below passes it as
// `sourceKeyPrefix` so candidate selection is scoped to fixtures this file
// owns — never "whatever's most recent by sourceType," which previously
// let real corpus items (this suite ran against a persistent shared dev
// database, not a fresh one per run) get swept up and permanently embedded
// with the mock provider. See "does not touch unrelated data" below for
// the regression test proving this.
const TEST_SOURCE_KEY_PREFIX = "embedtest:";

describeIfDb("Semantic embeddings and retrieval (real PostgreSQL + pgvector)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let embeddingService: typeof import("@/lib/ai/embeddingService");
  let semanticSearchModule: typeof import("@/lib/ai/semanticSearch");
  let mockEmbeddingModule: typeof import("@/lib/ai/mockEmbeddingProvider");
  let semanticDocumentModule: typeof import("@/lib/ai/semanticDocument");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    embeddingService = await import("@/lib/ai/embeddingService");
    semanticSearchModule = await import("@/lib/ai/semanticSearch");
    mockEmbeddingModule = await import("@/lib/ai/mockEmbeddingProvider");
    semanticDocumentModule = await import("@/lib/ai/semanticDocument");
  });

  async function cleanup() {
    // bookmarks has ON DELETE RESTRICT (not cascade) — must clear it first,
    // matching bookmarks.integration.test.ts's established cleanup order.
    await db.getDb()!.execute(sql`delete from bookmarks where feed_item_id in (
      select id from feed_items where source_key like ${TEST_SOURCE_KEY_PREFIX + "%"}
    )`);
    await db.getDb()!.execute(sql`delete from feed_items where source_key like ${TEST_SOURCE_KEY_PREFIX + "%"}`);
  }
  // Runs before AND after every test (not just before) so a failing
  // assertion still leaves the database clean for whatever runs next,
  // rather than relying solely on the next test's own beforeEach.
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
        title: `Embedding test item ${counter}`,
        description: "A description with enough real content to embed meaningfully.",
        publishedAt: new Date(Date.now() - counter * 1000).toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: `https://example.com/embedtest-${counter}`,
        ...overrides,
        id,
      },
    ]);
    const item = await repo.getFeedItemForEnrichment(id);
    if (!item) throw new Error("test setup failed");
    return { sourceKey: id, feedItemId: item.feedItemId };
  }

  async function getEmbeddingRowCount(feedItemId: number): Promise<number> {
    const rows = await db
      .getDb()!
      .execute(sql`select count(*)::int as count from feed_item_embeddings where feed_item_id = ${feedItemId}`);
    const [{ count }] = rows as unknown as { count: number }[];
    return count;
  }

  describe("embedRecentItems / previewEmbeddingCandidates", () => {
    it("first run: embeds a new item exactly once via the provider and persists the vector", async () => {
      const { sourceKey, feedItemId } = await seedItem();
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      let calls = 0;
      const countingProvider = {
        ...provider,
        embed: async (texts: string[]) => {
          calls++;
          return provider.embed(texts);
        },
      };

      const result = await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider: countingProvider });
      expect(result.providerConfigured).toBe(true);
      const outcome = result.outcomes.find((o) => o.sourceKey === sourceKey);
      expect(outcome?.status).toBe("embedded");
      expect(calls).toBe(1);
      expect(await getEmbeddingRowCount(feedItemId)).toBe(1);
    });

    it("second run with unchanged content: zero provider calls (already current)", async () => {
      const { sourceKey } = await seedItem();
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      let calls = 0;
      const countingProvider = {
        ...provider,
        embed: async (texts: string[]) => {
          calls++;
          return provider.embed(texts);
        },
      };

      await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider: countingProvider });
      expect(calls).toBe(1);

      const second = await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider: countingProvider });
      expect(calls).toBe(1); // no new call
      expect(second.outcomes.find((o) => o.sourceKey === sourceKey)).toBeUndefined(); // not eligible, not reprocessed
    });

    it("changed content produces a new hash and is re-embedded", async () => {
      const { sourceKey, feedItemId } = await seedItem({ title: "Original title" });
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();

      await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });
      const firstRowsRaw = await db
        .getDb()!
        .execute(sql`select input_hash from feed_item_embeddings where feed_item_id = ${feedItemId}`);
      const firstHash = (firstRowsRaw as unknown as { input_hash: string }[])[0].input_hash;

      await seedItem({ id: sourceKey, title: "A genuinely different title" });
      const result = await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });
      expect(result.outcomes.find((o) => o.sourceKey === sourceKey)?.status).toBe("embedded");

      const secondRowsRaw = await db
        .getDb()!
        .execute(sql`select input_hash from feed_item_embeddings where feed_item_id = ${feedItemId}`);
      const secondHash = (secondRowsRaw as unknown as { input_hash: string }[])[0].input_hash;
      expect(secondHash).not.toBe(firstHash);
      expect(await getEmbeddingRowCount(feedItemId)).toBe(1); // upsert in place, never a duplicate
    });

    it("idempotent upsert: repeated embedding of the same content never creates a duplicate row", async () => {
      const { feedItemId } = await seedItem();
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });
      expect(await getEmbeddingRowCount(feedItemId)).toBe(1);
      // A second call with the same (unchanged) item is filtered out before
      // the provider is ever invoked (see "zero provider calls" test above)
      // — this test specifically checks the DB-level guarantee: even if
      // upsertFeedItemEmbedding were called again with identical content,
      // the unique index prevents a duplicate.
      await repo.upsertFeedItemEmbedding({
        feedItemId,
        provider: "mock",
        model: "mock-embedding-v1",
        embeddingVersion: semanticDocumentModule.EMBEDDING_SCHEMA_VERSION,
        inputHash: "some-hash",
        embedding: [1, 2, 3, 4, 5, 6, 7, 8],
        dimensions: 8,
      });
      expect(await getEmbeddingRowCount(feedItemId)).toBe(1);
    });

    it("dry run: zero provider calls, zero database mutations", async () => {
      // No OPENAI_EMBEDDING_MODEL is set in the test environment (by
      // design — see embeddingProvider.ts), so this exercises the real,
      // unconfigured `getEmbeddingProvider()` path. previewEmbeddingCandidates
      // has no injectable provider (mirroring enrichmentService.ts's
      // previewEligibleCandidates, which has the same limitation) — the
      // guarantee this test actually verifies is structural: the function
      // never imports or calls anything from the embed/write path at all,
      // so there is no code path by which it COULD call a provider.
      const { feedItemId } = await seedItem();
      const { items } = await embeddingService.previewEmbeddingCandidates({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX });
      expect(items.length).toBeGreaterThan(0);
      expect(await getEmbeddingRowCount(feedItemId)).toBe(0);
    });

    it("no provider configured: embedRecentItems is a safe no-op", async () => {
      const result = await embeddingService.embedRecentItems({ limit: 5 });
      expect(result.providerConfigured).toBe(false);
      expect(result.outcomes).toEqual([]);
    });

    it("no provider configured: previewEmbeddingCandidates still lists the corpus but marks nothing as would-embed", async () => {
      await seedItem();
      const { providerConfigured, items } = await embeddingService.previewEmbeddingCandidates({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX });
      expect(providerConfigured).toBe(false);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.wouldEmbed === false)).toBe(true);
    });

    it("Step 27B: AI_EGRESS_DISABLED=1 blocks embedRecentItems even with valid-looking credentials — zero provider calls, zero writes", async () => {
      const { feedItemId } = await seedItem();
      const originalEnv = { ...process.env };
      try {
        process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
        process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
        process.env.AI_EGRESS_DISABLED = "1";

        const result = await embeddingService.embedRecentItems({
          limit: 5,
          sourceType: "hackernews",
          sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX,
        });
        expect(result.providerConfigured).toBe(false);
        expect(result.outcomes).toEqual([]);
        expect(await getEmbeddingRowCount(feedItemId)).toBe(0);
      } finally {
        process.env = originalEnv;
      }
    });

    it("Step 27B: AI_EGRESS_DISABLED=1 makes previewEmbeddingCandidates report providerConfigured:false, even with valid-looking credentials", async () => {
      await seedItem();
      const originalEnv = { ...process.env };
      try {
        process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
        process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
        process.env.AI_EGRESS_DISABLED = "1";

        const { providerConfigured, items } = await embeddingService.previewEmbeddingCandidates({
          limit: 5,
          sourceType: "hackernews",
          sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX,
        });
        expect(providerConfigured).toBe(false);
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((i) => i.wouldEmbed === false)).toBe(true);
      } finally {
        process.env = originalEnv;
      }
    });

    it("embedding provider failure is isolated: reports failed outcomes, writes nothing, never throws", async () => {
      const { sourceKey, feedItemId } = await seedItem();
      const failingProvider = {
        name: "mock",
        model: "mock-embedding-v1",
        embed: async () => {
          throw new Error("simulated embedding provider outage");
        },
      };

      const result = await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider: failingProvider });
      expect(result.providerConfigured).toBe(true);
      expect(result.outcomes.find((o) => o.sourceKey === sourceKey)?.status).toBe("failed");
      expect(await getEmbeddingRowCount(feedItemId)).toBe(0);
    });
  });

  describe("semanticSearch / hybridSearch / lexicalSearch", () => {
    it("semanticSearch returns [] safely for a corpus with no embedded documents yet", async () => {
      await seedItem();
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      const results = await semanticSearchModule.semanticSearch("some query", {}, 10, { provider });
      expect(results).toEqual([]);
    });

    it("semanticSearch finds the most similar embedded item first", async () => {
      // The mock embedding provider is a deterministic hash of the exact
      // text it's given — it cannot model real semantic meaning, so this
      // test proves the RETRIEVAL PLUMBING (query embedding -> vector
      // search -> correct distance ordering) rather than embedding
      // quality: querying with the item's own fully-constructed semantic
      // document (title + summary, exactly as embedRecentItems built it)
      // must embed to the identical vector and rank first at distance 0.
      const summary = "A description with enough real content to embed meaningfully.";
      const target = await seedItem({ title: "Efficient training of small language models", description: summary });
      const distractor = await seedItem({ title: "A completely unrelated cooking recipe blog post", description: summary });
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });

      const targetDocument = semanticDocumentModule.toSemanticDocument({
        title: "Efficient training of small language models",
        summary,
        sourceType: "hackernews",
        sourceName: "Hacker News",
        tags: null,
        authors: null,
        repositoryFullName: null,
      });

      const results = await semanticSearchModule.semanticSearch(targetDocument, {}, 10, { provider });
      const sourceKeys = results.map((r) => r.item.id);
      expect(sourceKeys).toContain(target.sourceKey);
      expect(sourceKeys).toContain(distractor.sourceKey);
      expect(sourceKeys[0]).toBe(target.sourceKey);
    });

    it("filters (sourceType) are applied correctly to semantic retrieval", async () => {
      const hn = await seedItem({ sourceType: "hackernews", sourceName: "Hacker News" });
      const paper = await seedItem({ id: `embedtest:${++counter}`, sourceType: "paper", sourceName: "arXiv" });
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      await embeddingService.embedRecentItems({ limit: 10, sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });

      const results = await semanticSearchModule.semanticSearch("Embedding test item", { sourceType: "paper" }, 10, { provider });
      const sourceKeys = results.map((r) => r.item.id);
      expect(sourceKeys).toContain(paper.sourceKey);
      expect(sourceKeys).not.toContain(hn.sourceKey);
    });

    it("filters (bookmarkedOnly) are applied correctly to semantic retrieval", async () => {
      const bookmarked = await seedItem();
      const notBookmarked = await seedItem();
      await repo.addBookmark(bookmarked.sourceKey);
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      await embeddingService.embedRecentItems({ limit: 10, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });

      const results = await semanticSearchModule.semanticSearch("Embedding test item", { bookmarkedOnly: true }, 10, { provider });
      const sourceKeys = results.map((r) => r.item.id);
      expect(sourceKeys).toContain(bookmarked.sourceKey);
      expect(sourceKeys).not.toContain(notBookmarked.sourceKey);
    });

    it("respects the limit/pagination bound", async () => {
      for (let i = 0; i < 5; i++) await seedItem();
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      await embeddingService.embedRecentItems({ limit: 10, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });

      const results = await semanticSearchModule.semanticSearch("Embedding test item", {}, 2, { provider });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("non-embedded documents are simply absent from results, not an error", async () => {
      const embedded = await seedItem();
      const notEmbedded = await seedItem();
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      // Embed only the first item directly, leaving the second with no row.
      await repo.upsertFeedItemEmbedding({
        feedItemId: embedded.feedItemId,
        provider: provider.name,
        model: provider.model,
        embeddingVersion: semanticDocumentModule.EMBEDDING_SCHEMA_VERSION,
        inputHash: "h",
        embedding: (await provider.embed(["x"])).embeddings[0].embedding,
        dimensions: 8,
      });

      const results = await semanticSearchModule.semanticSearch("Embedding test item", {}, 10, { provider });
      const sourceKeys = results.map((r) => r.item.id);
      expect(sourceKeys).toContain(embedded.sourceKey);
      expect(sourceKeys).not.toContain(notEmbedded.sourceKey);
    });

    it("lexicalSearch wraps the unmodified Step 8 full-text search — same items it would return directly", async () => {
      const { sourceKey } = await seedItem({ title: "A very specific unique lexical marker XYZQ123" });
      const results = await semanticSearchModule.lexicalSearch("XYZQ123", {}, 10);
      expect(results.some((r) => r.item.id === sourceKey)).toBe(true);
    });

    it("hybridSearch fusion is deterministic across repeated calls with identical state", async () => {
      const a = await seedItem({ title: "Efficient training of small language models" });
      const b = await seedItem({ title: "A completely unrelated cooking recipe blog post" });
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      await embeddingService.embedRecentItems({ limit: 10, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });

      const first = await semanticSearchModule.hybridSearch("Efficient training of small language models", {}, 10, { provider });
      const second = await semanticSearchModule.hybridSearch("Efficient training of small language models", {}, 10, { provider });
      expect(first.map((r) => r.item.id)).toEqual(second.map((r) => r.item.id));
      expect(first.map((r) => r.score)).toEqual(second.map((r) => r.score));
      void a;
      void b;
    });

    it("hybridSearch degrades gracefully to lexical-only ranking when no embedding provider is configured", async () => {
      // No `provider` passed and no OPENAI_EMBEDDING_MODEL set in the test
      // environment — semanticSearch's internal getEmbeddingProvider() call
      // naturally returns null here, exercising the real no-op path.
      const { sourceKey } = await seedItem({ title: "A very specific unique lexical marker ABCD456" });
      const results = await semanticSearchModule.hybridSearch("ABCD456", {}, 10);
      expect(results.some((r) => r.item.id === sourceKey)).toBe(true);
    });
  });

  describe("vector dimension consistency", () => {
    it("rejects an embedding row whose declared dimensions do not match the actual vector length", async () => {
      const { feedItemId } = await seedItem();
      await expect(
        repo.upsertFeedItemEmbedding({
          feedItemId,
          provider: "mock",
          model: "mock-embedding-v1",
          embeddingVersion: 1,
          inputHash: "h",
          embedding: [1, 2, 3],
          dimensions: 5, // mismatched on purpose
        })
      ).rejects.toThrow();
      expect(await getEmbeddingRowCount(feedItemId)).toBe(0);
    });
  });

  describe("does not touch unrelated data", () => {
    // Regression test for the exact defect this file used to have: every
    // embedRecentItems call above previously scoped candidates by
    // `sourceType` alone, which (against a persistent shared dev database,
    // not a fresh one per run) let real, unrelated hackernews items get
    // swept into the pool and permanently embedded with the mock provider.
    // This proves an unrelated item — deliberately made MORE recent than
    // every fixture this test seeds, so it would sort first in any
    // recency-ordered, sourceType-only pool — survives completely
    // untouched now that every call above is scoped by `sourceKeyPrefix`.
    const SENTINEL_KEY = "unrelated-real-corpus-item:sentinel";

    async function seedSentinel() {
      await repo.upsertFeedItems([
        {
          id: SENTINEL_KEY,
          sourceType: "hackernews",
          sourceName: "Hacker News",
          title: "An unrelated real item this suite must never touch",
          description: "Stands in for a genuine dev-corpus item, not a embedtest: fixture.",
          // Deliberately in the future — the most recent row in the whole
          // table for its sourceType, so a sourceType-only (unscoped) pool
          // query would rank it first, ahead of every embedtest: fixture.
          publishedAt: new Date(Date.now() + 60_000).toISOString(),
          tags: [],
          score: 0,
          commentCount: 0,
          url: "https://example.com/unrelated-real-corpus-item",
        },
      ]);
      const item = await repo.getFeedItemForEnrichment(SENTINEL_KEY);
      if (!item) throw new Error("sentinel setup failed");
      return item.feedItemId;
    }

    async function deleteSentinel() {
      await db.getDb()!.execute(sql`delete from feed_items where source_key = ${SENTINEL_KEY}`);
    }

    it("an unrelated, more-recent item survives untouched by a sourceType-scoped embed run", async () => {
      const sentinelFeedItemId = await seedSentinel();
      try {
        const provider = mockEmbeddingModule.createMockEmbeddingProvider();
        // Give the sentinel its own baseline embedding row first, exactly
        // like a real already-embedded corpus item would have.
        await repo.upsertFeedItemEmbedding({
          feedItemId: sentinelFeedItemId,
          provider: provider.name,
          model: provider.model,
          embeddingVersion: semanticDocumentModule.EMBEDDING_SCHEMA_VERSION,
          inputHash: "sentinel-baseline-hash",
          embedding: (await provider.embed(["sentinel"])).embeddings[0].embedding,
          dimensions: 8,
        });
        expect(await getEmbeddingRowCount(sentinelFeedItemId)).toBe(1);

        // Seed several embedtest: fixtures and run a normal, sourceType +
        // sourceKeyPrefix-scoped embed batch, same shape as every other
        // test in this file.
        for (let i = 0; i < 3; i++) await seedItem();
        await embeddingService.embedRecentItems({
          limit: 10,
          sourceType: "hackernews",
          sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX,
          provider,
        });

        // The sentinel's embedding row must be exactly what it was before
        // — not re-embedded, not duplicated, not deleted.
        expect(await getEmbeddingRowCount(sentinelFeedItemId)).toBe(1);
        const rows = await db
          .getDb()!
          .execute(sql`select input_hash from feed_item_embeddings where feed_item_id = ${sentinelFeedItemId}`);
        const [{ input_hash: hash }] = rows as unknown as { input_hash: string }[];
        expect(hash).toBe("sentinel-baseline-hash");

        // And the sentinel feed item itself is untouched.
        const stillThere = await repo.getFeedItemForEnrichment(SENTINEL_KEY);
        expect(stillThere).not.toBeNull();
      } finally {
        // Owned by this test alone — the shared cleanup() only ever
        // touches TEST_SOURCE_KEY_PREFIX, so this sentinel is this test's
        // sole responsibility to remove.
        await deleteSentinel();
      }
    });
  });

  describe("cascading delete", () => {
    it("removing a feed item removes its embedding row", async () => {
      const { sourceKey, feedItemId } = await seedItem();
      const provider = mockEmbeddingModule.createMockEmbeddingProvider();
      await embeddingService.embedRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: TEST_SOURCE_KEY_PREFIX, provider });
      expect(await getEmbeddingRowCount(feedItemId)).toBe(1);

      await db.getDb()!.execute(sql`delete from feed_items where source_key = ${sourceKey}`);
      expect(await getEmbeddingRowCount(feedItemId)).toBe(0);
    });
  });
});

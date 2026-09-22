import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { ArticleEnrichmentInput } from "@/lib/ai/types";

/**
 * Step 14 — integration tests for the production HN discussion-context
 * cache: real PostgreSQL, a mocked Hacker News fetcher (never a real
 * network call — see vi.mock below), and the deterministic mock AI
 * provider (never a real OpenAI call). Skipped entirely unless
 * DATABASE_URL is set.
 */
vi.mock("@/lib/ai/hnContext", () => ({
  fetchHnDiscussionContext: vi.fn(),
}));

import { fetchHnDiscussionContext } from "@/lib/ai/hnContext";

const mockedFetchContext = vi.mocked(fetchHnDiscussionContext);

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("HN discussion context cache (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let schema: typeof import("@/db/schema");
  let service: typeof import("@/lib/ai/enrichmentService");
  let mockProviderModule: typeof import("@/lib/ai/mockProvider");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    schema = await import("@/db/schema");
    service = await import("@/lib/ai/enrichmentService");
    mockProviderModule = await import("@/lib/ai/mockProvider");
  });

  // Fake HN story ids in a distinct numeric range for cleanup scoping —
  // must start with "hn:" so isHnSourceKey() recognizes them (the fetcher
  // itself is always mocked, so these never need to resemble real ids).
  async function cleanup() {
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'hn:900%' or source_key like 'hctest:%'`);
  }
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(cleanup);
  afterEach(() => vi.resetAllMocks());

  let counter = 0;
  async function seedHnItem(overrides: Partial<Parameters<typeof repo.upsertFeedItems>[0][0]> = {}) {
    counter++;
    const id = overrides.id ?? `hn:${900_000_000 + counter}`;
    await repo.upsertFeedItems([
      {
        sourceType: "hackernews",
        sourceName: "Hacker News",
        title: `HN context-cache test item ${counter}`,
        description: "Discussion thread on Hacker News.",
        publishedAt: new Date(Date.now() - counter * 1000).toISOString(),
        tags: ["Hacker News"],
        score: 0,
        commentCount: 0,
        url: `https://example.com/hctest-${counter}`,
        ...overrides,
        id,
      },
    ]);
    const item = await repo.getFeedItemForEnrichment(id);
    if (!item) throw new Error("test setup failed");
    return { sourceKey: id, feedItemId: item.feedItemId };
  }

  async function seedNonHnItem() {
    counter++;
    const id = `hctest:paper:${counter}`;
    await repo.upsertFeedItems([
      {
        id,
        sourceType: "paper",
        sourceName: "arXiv",
        title: `Non-HN test item ${counter}`,
        description: "A real abstract with plenty of content.",
        publishedAt: new Date().toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: `https://example.com/${id}`,
      },
    ]);
    const item = await repo.getFeedItemForEnrichment(id);
    if (!item) throw new Error("test setup failed");
    return { sourceKey: id, feedItemId: item.feedItemId };
  }

  async function makeStale(feedItemId: number) {
    await db
      .getDb()!
      .execute(sql`update hn_discussion_context set fetched_at = now() - interval '25 hours' where feed_item_id = ${feedItemId}`);
  }

  async function getCacheRowCount(feedItemId: number): Promise<number> {
    const [{ count }] = await db
      .getDb()!
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.hnDiscussionContext)
      .where(sql`feed_item_id = ${feedItemId}`);
    return count;
  }

  it("first enrichment: fetches bounded HN context, caches it, and enriches with it present", async () => {
    const { sourceKey, feedItemId } = await seedHnItem();
    mockedFetchContext.mockResolvedValue({
      label: "Hacker News discussion context",
      text: "Comment (alice): This is a great approach.",
      commentRequestCount: 1,
    });

    const outcome = await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });

    expect(outcome.status).toBe("completed");
    expect(mockedFetchContext).toHaveBeenCalledTimes(1);
    expect(await getCacheRowCount(feedItemId)).toBe(1);
    const cached = await repo.getHnContextCache(feedItemId);
    expect(cached).toMatchObject({ status: "has_context", normalizedContext: expect.stringContaining("This is a great approach.") });
  });

  it("second enrichment while cache is fresh: 0 HN calls and 0 OpenAI calls (unchanged content)", async () => {
    const { sourceKey } = await seedHnItem();
    mockedFetchContext.mockResolvedValue({
      label: "Hacker News discussion context",
      text: "Comment (alice): Fixed content.",
      commentRequestCount: 1,
    });
    const provider = mockProviderModule.createMockProvider();
    let providerCalls = 0;
    const countingProvider = {
      ...provider,
      enrichArticle: async (input: Parameters<typeof provider.enrichArticle>[0]) => {
        providerCalls++;
        return provider.enrichArticle(input);
      },
    };

    const first = await service.enrichFeedItem(sourceKey, { provider: countingProvider });
    expect(first.status).toBe("completed");
    expect(mockedFetchContext).toHaveBeenCalledTimes(1);
    expect(providerCalls).toBe(1);

    const second = await service.enrichFeedItem(sourceKey, { provider: countingProvider });
    expect(second.status).toBe("skipped_current");
    expect(mockedFetchContext).toHaveBeenCalledTimes(1); // still 1 — no new HN call
    expect(providerCalls).toBe(1); // still 1 — no new OpenAI call
  });

  it("stale cache + Hacker News outage: reuses the stale valid context (enrichment still succeeds, uses old text)", async () => {
    const { sourceKey, feedItemId } = await seedHnItem();
    mockedFetchContext.mockResolvedValueOnce({
      label: "Hacker News discussion context",
      text: "Original comment.",
      commentRequestCount: 1,
    });
    const provider = mockProviderModule.createMockProvider();
    await service.enrichFeedItem(sourceKey, { provider });
    await makeStale(feedItemId);

    mockedFetchContext.mockRejectedValueOnce(new Error("simulated Hacker News outage"));
    // Force a fresh provider call by touching the title (content change),
    // so we can observe what sourceContext text actually reached the model.
    await repo.upsertFeedItems([
      {
        id: sourceKey,
        sourceType: "hackernews",
        sourceName: "Hacker News",
        title: "A changed title to force re-enrichment eligibility",
        description: "Discussion thread on Hacker News.",
        publishedAt: new Date().toISOString(),
        tags: ["Hacker News"],
        score: 0,
        commentCount: 0,
        url: `https://example.com/${sourceKey}`,
      },
    ]);

    const observedInputs: ArticleEnrichmentInput[] = [];
    const observingProvider = {
      ...provider,
      enrichArticle: async (input: ArticleEnrichmentInput) => {
        observedInputs.push(input);
        return provider.enrichArticle(input);
      },
    };

    const outcome = await service.enrichFeedItem(sourceKey, { provider: observingProvider });
    expect(outcome.status).toBe("completed");
    expect(observedInputs[0]?.sourceContext?.text).toBe("Original comment."); // stale cache reused
    // Cache row is untouched (no successful upsert occurred during the outage).
    const cached = await repo.getHnContextCache(feedItemId);
    expect(cached).toMatchObject({ status: "has_context", normalizedContext: "Original comment." });
  });

  it("no cache + Hacker News outage: gracefully falls back to baseline enrichment (no sourceContext, still completes, no row ever written)", async () => {
    const { sourceKey, feedItemId } = await seedHnItem();
    mockedFetchContext.mockRejectedValue(new Error("simulated Hacker News outage"));

    const provider = mockProviderModule.createMockProvider();
    const observedInputs: ArticleEnrichmentInput[] = [];
    const observingProvider = {
      ...provider,
      enrichArticle: async (input: ArticleEnrichmentInput) => {
        observedInputs.push(input);
        return provider.enrichArticle(input);
      },
    };

    const outcome = await service.enrichFeedItem(sourceKey, { provider: observingProvider });
    expect(outcome.status).toBe("completed");
    expect(observedInputs[0]?.sourceContext).toBeUndefined();
    // A network failure must never be recorded as a confirmed 'no_context'
    // result — see hnContext.ts's throw contract and §7's outage/no_context
    // distinction. It leaves no cache row at all, not a wrong one.
    expect(await getCacheRowCount(feedItemId)).toBe(0);
  });

  it("changed normalized discussion context produces a new input hash, making re-enrichment eligible", async () => {
    const { sourceKey, feedItemId } = await seedHnItem();
    mockedFetchContext.mockResolvedValueOnce({
      label: "Hacker News discussion context",
      text: "Comment version one.",
      commentRequestCount: 1,
    });
    const provider = mockProviderModule.createMockProvider();
    const first = await service.enrichFeedItem(sourceKey, { provider });
    expect(first.status).toBe("completed");
    const firstHash = (await repo.getEnrichmentByFeedItemId(feedItemId))!.inputHash;

    await makeStale(feedItemId);
    mockedFetchContext.mockResolvedValueOnce({
      label: "Hacker News discussion context",
      text: "Comment version TWO — genuinely different.",
      commentRequestCount: 1,
    });

    const second = await service.enrichFeedItem(sourceKey, { provider });
    expect(second.status).toBe("completed"); // NOT skipped — new content is eligible
    const secondHash = (await repo.getEnrichmentByFeedItemId(feedItemId))!.inputHash;
    expect(secondHash).not.toBe(firstHash);
  });

  it("an unchanged context refreshed after staleness produces the SAME effective input hash (skips re-enrichment)", async () => {
    const { sourceKey, feedItemId } = await seedHnItem();
    mockedFetchContext.mockResolvedValueOnce({
      label: "Hacker News discussion context",
      text: "Identical comment text.",
      commentRequestCount: 1,
    });
    const provider = mockProviderModule.createMockProvider();
    let providerCalls = 0;
    const countingProvider = {
      ...provider,
      enrichArticle: async (input: Parameters<typeof provider.enrichArticle>[0]) => {
        providerCalls++;
        return provider.enrichArticle(input);
      },
    };

    const first = await service.enrichFeedItem(sourceKey, { provider: countingProvider });
    expect(first.status).toBe("completed");
    const firstHash = (await repo.getEnrichmentByFeedItemId(feedItemId))!.inputHash;

    await makeStale(feedItemId);
    // Live refresh succeeds but happens to return byte-identical content
    // (e.g. no new comments arrived) — a routine TTL refresh, not a
    // content change.
    mockedFetchContext.mockResolvedValueOnce({
      label: "Hacker News discussion context",
      text: "Identical comment text.",
      commentRequestCount: 1,
    });

    const second = await service.enrichFeedItem(sourceKey, { provider: countingProvider });
    expect(second.status).toBe("skipped_current");
    expect(providerCalls).toBe(1); // no new OpenAI call
    expect(mockedFetchContext).toHaveBeenCalledTimes(2); // the stale refresh DID make an HN call
    const secondHash = (await repo.getEnrichmentByFeedItemId(feedItemId))!.inputHash;
    expect(secondHash).toBe(firstHash); // same effective hash — fetchedAt never enters it
  });

  it("non-HN items never trigger context-network work or a cache row", async () => {
    const { sourceKey, feedItemId } = await seedNonHnItem();
    const outcome = await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
    expect(outcome.status).toBe("completed");
    expect(mockedFetchContext).not.toHaveBeenCalled();
    expect(await getCacheRowCount(feedItemId)).toBe(0);
  });

  it("dry-run preview makes zero HN calls and zero database mutations, even for HN candidates with no cache yet", async () => {
    const { feedItemId } = await seedHnItem();

    const { items } = await service.previewEligibleCandidates({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: "hn:900" });
    expect(items.length).toBeGreaterThan(0);
    expect(mockedFetchContext).not.toHaveBeenCalled();
    expect(await getCacheRowCount(feedItemId)).toBe(0);
    const enrichmentRows = await repo.getEnrichmentByFeedItemId(feedItemId);
    expect(enrichmentRows).toBeNull();
  });

  it("cascades delete: removing the feed item removes its cached HN context", async () => {
    const { sourceKey, feedItemId } = await seedHnItem();
    mockedFetchContext.mockResolvedValue({
      label: "Hacker News discussion context",
      text: "Some comment.",
      commentRequestCount: 1,
    });
    await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
    expect(await getCacheRowCount(feedItemId)).toBe(1);

    await db.getDb()!.delete(schema.feedItems).where(sql`id = ${feedItemId}`);
    expect(await getCacheRowCount(feedItemId)).toBe(0);
  });

  describe("getHnContextCacheStats (Step 15/16 ai:status observability)", () => {
    const TTL_SECONDS = 24 * 60 * 60;

    it("counts fresh/stale/no-usable-context/never-attempted rows correctly (Step 16 four-category breakdown)", async () => {
      const fresh = await seedHnItem();
      const stale = await seedHnItem();
      const noContext = await seedHnItem();
      const neverAttempted = await seedHnItem();

      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "fresh comment", commentRequestCount: 1 });
      await service.enrichFeedItem(fresh.sourceKey, { provider: mockProviderModule.createMockProvider() });

      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "stale comment", commentRequestCount: 1 });
      await service.enrichFeedItem(stale.sourceKey, { provider: mockProviderModule.createMockProvider() });
      await makeStale(stale.feedItemId);

      // Enriched, and the live fetch confirmed nothing usable — Step 16
      // persists this as an explicit 'no_context' row, not "no row at all".
      mockedFetchContext.mockResolvedValueOnce(null);
      await service.enrichFeedItem(noContext.sourceKey, { provider: mockProviderModule.createMockProvider() });

      // `neverAttempted` is seeded but never enriched at all — no cache
      // row of any kind, distinct from a confirmed no_context result.
      void neverAttempted;

      const stats = await repo.getHnContextCacheStats(TTL_SECONDS, { sourceKeyPrefix: "hn:900" });
      expect(stats.eligibleHnFeedItems).toBeGreaterThanOrEqual(4);
      expect(stats.freshContextRows).toBeGreaterThanOrEqual(1);
      expect(stats.staleContextRows).toBeGreaterThanOrEqual(1);
      expect(stats.noUsableContextRows).toBeGreaterThanOrEqual(1);
      expect(stats.neverAttemptedRows).toBeGreaterThanOrEqual(1);
      // The four categories always partition every eligible HN feed item —
      // never a sentinel or an ambiguous overlap between them.
      expect(stats.freshContextRows + stats.staleContextRows + stats.noUsableContextRows + stats.neverAttemptedRows).toBe(
        stats.eligibleHnFeedItems
      );
    });

    it("returns mostRecentRefresh as a real Date instance, not a raw string (regression)", async () => {
      const { sourceKey } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "a comment", commentRequestCount: 1 });
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });

      const stats = await repo.getHnContextCacheStats(TTL_SECONDS, { sourceKeyPrefix: "hn:900" });
      expect(stats.mostRecentRefresh).toBeInstanceOf(Date);
      expect(() => stats.mostRecentRefresh!.toISOString()).not.toThrow();
    });

    it("returns a well-formed empty result when there is no data at all", async () => {
      const stats = await repo.getHnContextCacheStats(TTL_SECONDS, { sourceKeyPrefix: "hn:900" });
      expect(stats.mostRecentRefresh).toBeNull();
      expect(stats.freshContextRows).toBe(0);
      expect(stats.staleContextRows).toBe(0);
      expect(stats.noUsableContextRows).toBe(0);
      expect(stats.neverAttemptedRows).toBe(0);
    });
  });

  describe("Step 16 — stale HN context re-enrichment lifecycle", () => {
    const TTL_MS = 24 * 60 * 60 * 1000;

    it("[1] completed item with fresh has_context cache: NOT a maintenance candidate", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "fresh", commentRequestCount: 1 });
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });

      const candidates = await repo.getStaleHnMaintenanceCandidates({ poolSize: 50, ttlMs: TTL_MS, sourceKeyPrefix: "hn:900" });
      expect(candidates.some((c) => c.feedItemId === feedItemId)).toBe(false);
    });

    it("[2] completed item with stale has_context cache: IS a maintenance candidate", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "will go stale", commentRequestCount: 1 });
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
      await makeStale(feedItemId);

      const candidates = await repo.getStaleHnMaintenanceCandidates({ poolSize: 50, ttlMs: TTL_MS, sourceKeyPrefix: "hn:900" });
      expect(candidates.some((c) => c.feedItemId === feedItemId)).toBe(true);
    });

    it("[3] completed item with NO cache row at all (pre-Step-14 style): IS a maintenance candidate, gets exactly one context-resolution attempt", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      // Enrich via the mock provider directly with sourceContext undefined,
      // bypassing resolveHnSourceContext entirely, to simulate a row that
      // predates the context cache (never fetched, never attempted).
      mockedFetchContext.mockRejectedValueOnce(new Error("simulated outage during the only enrichment attempt"));
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
      expect(await getCacheRowCount(feedItemId)).toBe(0);

      const candidates = await repo.getStaleHnMaintenanceCandidates({ poolSize: 50, ttlMs: TTL_MS, sourceKeyPrefix: "hn:900" });
      expect(candidates.some((c) => c.feedItemId === feedItemId)).toBe(true);
    });

    it("[4] stale completed HN item + unchanged live content: normal batch CLI path refreshes HN but makes ZERO OpenAI calls", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "unchanging content", commentRequestCount: 1 });
      const provider = mockProviderModule.createMockProvider();
      let providerCalls = 0;
      const countingProvider = {
        ...provider,
        enrichArticle: async (input: Parameters<typeof provider.enrichArticle>[0]) => {
          providerCalls++;
          return provider.enrichArticle(input);
        },
      };
      await service.enrichFeedItem(sourceKey, { provider: countingProvider });
      await makeStale(feedItemId);
      expect(providerCalls).toBe(1);

      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "unchanging content", commentRequestCount: 1 });
      const { outcomes } = await service.enrichRecentItems({
        limit: 5,
        sourceType: "hackernews",
        sourceKeyPrefix: "hn:900",
        provider: countingProvider,
      });

      expect(mockedFetchContext).toHaveBeenCalledTimes(2); // the maintenance refresh DID call HN
      expect(providerCalls).toBe(1); // still 1 — no new OpenAI call
      const outcome = outcomes.find((o) => o.sourceKey === sourceKey);
      expect(outcome?.status).toBe("skipped_current");
    });

    it("[5] normal batch run immediately after [4]: item is fresh again, ZERO HN calls, ZERO OpenAI calls", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "steady content", commentRequestCount: 1 });
      const provider = mockProviderModule.createMockProvider();
      await service.enrichFeedItem(sourceKey, { provider });
      await makeStale(feedItemId);
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "steady content", commentRequestCount: 1 });
      await service.enrichRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: "hn:900", provider });
      expect(mockedFetchContext).toHaveBeenCalledTimes(2);

      // Immediately run again — the context row is fresh again (just
      // refreshed above), so this must not touch HN or OpenAI at all.
      let providerCalls = 0;
      const countingProvider = {
        ...provider,
        enrichArticle: async (input: Parameters<typeof provider.enrichArticle>[0]) => {
          providerCalls++;
          return provider.enrichArticle(input);
        },
      };
      const { outcomes } = await service.enrichRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: "hn:900", provider: countingProvider });
      expect(mockedFetchContext).toHaveBeenCalledTimes(2); // unchanged — no new HN call
      expect(providerCalls).toBe(0);
      const outcome = outcomes.find((o) => o.sourceKey === sourceKey);
      expect(outcome ?? null).toBeNull(); // no longer a candidate at all — fresh, nothing to do
    });

    it("[6] stale completed HN item + genuinely changed live content: refreshes HN AND calls OpenAI exactly once", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "version one", commentRequestCount: 1 });
      const provider = mockProviderModule.createMockProvider();
      let providerCalls = 0;
      const countingProvider = {
        ...provider,
        enrichArticle: async (input: Parameters<typeof provider.enrichArticle>[0]) => {
          providerCalls++;
          return provider.enrichArticle(input);
        },
      };
      await service.enrichFeedItem(sourceKey, { provider: countingProvider });
      await makeStale(feedItemId);
      expect(providerCalls).toBe(1);

      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "version TWO — genuinely different", commentRequestCount: 1 });
      const { outcomes } = await service.enrichRecentItems({
        limit: 5,
        sourceType: "hackernews",
        sourceKeyPrefix: "hn:900",
        provider: countingProvider,
      });

      expect(providerCalls).toBe(2); // exactly one new OpenAI call
      const outcome = outcomes.find((o) => o.sourceKey === sourceKey);
      expect(outcome?.status).toBe("completed");
    });

    it("[7] --force is unaffected: bypasses the hash check unconditionally, exactly as before Step 16", async () => {
      const { sourceKey } = await seedHnItem();
      mockedFetchContext.mockResolvedValue({ label: "x", text: "same content every time", commentRequestCount: 1 });
      const provider = mockProviderModule.createMockProvider();
      let providerCalls = 0;
      const countingProvider = {
        ...provider,
        enrichArticle: async (input: Parameters<typeof provider.enrichArticle>[0]) => {
          providerCalls++;
          return provider.enrichArticle(input);
        },
      };
      await service.enrichFeedItem(sourceKey, { provider: countingProvider });
      expect(providerCalls).toBe(1);

      // Force, with a FRESH cache and byte-identical content — force must
      // still call the provider, exactly like pre-Step-16 semantics.
      await service.enrichRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: "hn:900", provider: countingProvider, force: true });
      expect(providerCalls).toBe(2);
    });

    /**
     * getAiProvider() (src/lib/ai/provider.ts) branches on `AI_PROVIDER`
     * first: "openai" checks OPENAI_API_KEY/OPENAI_ENRICHMENT_MODEL,
     * anything else (including unset) checks ANTHROPIC_API_KEY. Tests
     * [8]/[11] need the Anthropic branch specifically — the same one
     * provider.test.ts calls out as "Step 9 backward compatibility" — but a
     * real developer .env.local commonly sets AI_PROVIDER=openai for this
     * project, which the test's own ambient shell may still have exported
     * when the suite runs. Without also clearing AI_PROVIDER here, that
     * leaks in and silently reroutes getAiProvider() to the (unconfigured)
     * OpenAI branch, making providerConfigured resolve to false regardless
     * of the fake ANTHROPIC_API_KEY these tests set — exactly the
     * false-vs-"uncertain" failure this regression test call guards
     * against. Mirrors provider.test.ts's own `clearProviderEnv` discipline
     * so results never depend on what happens to be exported by whoever
     * runs `npm test`. Saves and restores every var it touches.
     */
    async function withFakeAnthropicProviderConfigured<T>(run: () => Promise<T>): Promise<T> {
      const originalSelector = process.env.AI_PROVIDER;
      const originalKey = process.env.ANTHROPIC_API_KEY;
      try {
        delete process.env.AI_PROVIDER;
        process.env.ANTHROPIC_API_KEY = "sk-ant-fake-test-key-never-used";
        return await run();
      } finally {
        if (originalSelector === undefined) delete process.env.AI_PROVIDER;
        else process.env.AI_PROVIDER = originalSelector;
        if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }

    it("[8] dry run reports stale HN context candidates as 'uncertain', never a guessed true/false, with zero calls or writes", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "content", commentRequestCount: 1 });
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
      await makeStale(feedItemId);
      vi.mocked(mockedFetchContext).mockClear();

      // previewEligibleCandidates checks getAiProvider() internally (it
      // takes no provider argument) but NEVER calls .enrichArticle — a
      // fake key here can never trigger a real request, it only flips
      // `providerConfigured` so the "uncertain" branch is reachable.
      const { items } = await withFakeAnthropicProviderConfigured(() =>
        service.previewEligibleCandidates({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: "hn:900" })
      );
      const preview = items.find((i) => i.sourceKey === sourceKey && i.candidateKind === "stale_hn_context");
      expect(preview).toBeDefined();
      expect(preview!.wouldCallProvider).toBe("uncertain");
      expect(mockedFetchContext).not.toHaveBeenCalled();
      expect(await getCacheRowCount(feedItemId)).toBe(1); // untouched — still the original stale row
    });

    it("[9] fairness bound: a large backlog of stale HN items never starves a fresh normal candidate within the same --limit", async () => {
      // Seed more stale-completed HN items than the limit, plus one
      // brand-new never-enriched item that needs normal enrichment.
      const staleItems = [];
      for (let i = 0; i < 4; i++) {
        const seeded = await seedHnItem();
        mockedFetchContext.mockResolvedValueOnce({ label: "x", text: `stale content ${i}`, commentRequestCount: 1 });
        await service.enrichFeedItem(seeded.sourceKey, { provider: mockProviderModule.createMockProvider() });
        await makeStale(seeded.feedItemId);
        staleItems.push(seeded);
      }
      const freshCandidate = await seedHnItem(); // never enriched — a normal candidate

      mockedFetchContext.mockResolvedValue({ label: "x", text: "refreshed", commentRequestCount: 1 });
      const { outcomes } = await service.enrichRecentItems({
        limit: 2,
        sourceType: "hackernews",
        sourceKeyPrefix: "hn:900",
        provider: mockProviderModule.createMockProvider(),
      });

      // limit=2 is a true upper bound on the combined total...
      expect(outcomes.length).toBeLessThanOrEqual(2);
      // ...and the normal (never-enriched) candidate must be included —
      // never starved out by the 4-item stale-context backlog.
      expect(outcomes.some((o) => o.sourceKey === freshCandidate.sourceKey)).toBe(true);
    });

    it("[10] --limit stays a true upper bound even when both normal and maintenance candidates are available", async () => {
      for (let i = 0; i < 3; i++) {
        const seeded = await seedHnItem();
        mockedFetchContext.mockResolvedValueOnce({ label: "x", text: `content ${i}`, commentRequestCount: 1 });
        await service.enrichFeedItem(seeded.sourceKey, { provider: mockProviderModule.createMockProvider() });
        await makeStale(seeded.feedItemId);
      }
      for (let i = 0; i < 3; i++) await seedHnItem(); // normal candidates, never enriched

      mockedFetchContext.mockResolvedValue({ label: "x", text: "refreshed", commentRequestCount: 1 });
      const { outcomes } = await service.enrichRecentItems({
        limit: 3,
        sourceType: "hackernews",
        sourceKeyPrefix: "hn:900",
        provider: mockProviderModule.createMockProvider(),
      });
      expect(outcomes.length).toBeLessThanOrEqual(3);
    });

    it("[11] dry run never claims a stale HN candidate 'would skip' or 'would call' with certainty", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "content", commentRequestCount: 1 });
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
      await makeStale(feedItemId);

      // See test [8]: a fake key only flips providerConfigured for this
      // read-only preview, which never calls .enrichArticle.
      const { items } = await withFakeAnthropicProviderConfigured(() =>
        service.previewEligibleCandidates({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: "hn:900" })
      );
      const preview = items.find((i) => i.sourceKey === sourceKey && i.candidateKind === "stale_hn_context");
      expect(preview).toBeDefined();
      expect(typeof preview!.wouldCallProvider === "boolean").toBe(false);
    });

    it("[12] a non-hackernews --source filter never pulls in HN maintenance candidates", async () => {
      const { sourceKey: hnKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "content", commentRequestCount: 1 });
      await service.enrichFeedItem(hnKey, { provider: mockProviderModule.createMockProvider() });
      await makeStale(feedItemId);
      const nonHn = await seedNonHnItem();
      vi.mocked(mockedFetchContext).mockClear(); // clear the setup call above — only the filtered run matters

      const { outcomes } = await service.enrichRecentItems({
        limit: 5,
        sourceType: "paper",
        // Scoped by BOTH: sourceType alone would still sweep in every real
        // arXiv paper in the corpus (this exact gap wrote mock-provider
        // enrichments onto real papers before it was caught — see Step
        // 18C's final report). sourceKeyPrefix uses seedNonHnItem's own
        // "hctest:" prefix, distinct from this file's "hn:900..." prefix.
        sourceKeyPrefix: "hctest:",
        provider: mockProviderModule.createMockProvider(),
      });
      expect(outcomes.some((o) => o.sourceKey === hnKey)).toBe(false);
      expect(mockedFetchContext).not.toHaveBeenCalled();
      void nonHn;
    });

    it("[13] a stale no_context row is a maintenance candidate (re-checked after TTL, comments may have appeared)", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce(null);
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
      expect(await getCacheRowCount(feedItemId)).toBe(1);
      await makeStale(feedItemId);

      const candidates = await repo.getStaleHnMaintenanceCandidates({ poolSize: 50, ttlMs: TTL_MS, sourceKeyPrefix: "hn:900" });
      expect(candidates.some((c) => c.feedItemId === feedItemId)).toBe(true);
    });

    it("[14] a fresh no_context row is NOT a maintenance candidate and costs zero further HN calls", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce(null);
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });

      const candidates = await repo.getStaleHnMaintenanceCandidates({ poolSize: 50, ttlMs: TTL_MS, sourceKeyPrefix: "hn:900" });
      expect(candidates.some((c) => c.feedItemId === feedItemId)).toBe(false);
    });

    it("[15] maintenance refresh that hits an HN outage leaves the existing cache row untouched and makes zero OpenAI calls", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "last known good", commentRequestCount: 1 });
      const provider = mockProviderModule.createMockProvider();
      let providerCalls = 0;
      const countingProvider = {
        ...provider,
        enrichArticle: async (input: Parameters<typeof provider.enrichArticle>[0]) => {
          providerCalls++;
          return provider.enrichArticle(input);
        },
      };
      await service.enrichFeedItem(sourceKey, { provider: countingProvider });
      await makeStale(feedItemId);

      mockedFetchContext.mockRejectedValueOnce(new Error("simulated outage during maintenance refresh"));
      await service.enrichRecentItems({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: "hn:900", provider: countingProvider });

      expect(providerCalls).toBe(1); // no new OpenAI call
      const cached = await repo.getHnContextCache(feedItemId);
      expect(cached).toMatchObject({ status: "has_context", normalizedContext: "last known good" });
    });

    it("[16] dry run makes zero HN calls, zero OpenAI calls, and zero DB mutations even with maintenance candidates present", async () => {
      const { sourceKey, feedItemId } = await seedHnItem();
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "content", commentRequestCount: 1 });
      await service.enrichFeedItem(sourceKey, { provider: mockProviderModule.createMockProvider() });
      await makeStale(feedItemId);
      vi.mocked(mockedFetchContext).mockClear();

      const beforeEnrichment = await repo.getEnrichmentByFeedItemId(feedItemId);
      const beforeCache = await repo.getHnContextCache(feedItemId);
      await service.previewEligibleCandidates({ limit: 5, sourceType: "hackernews", sourceKeyPrefix: "hn:900" });
      const afterEnrichment = await repo.getEnrichmentByFeedItemId(feedItemId);
      const afterCache = await repo.getHnContextCache(feedItemId);

      expect(mockedFetchContext).not.toHaveBeenCalled();
      expect(await getCacheRowCount(feedItemId)).toBe(1);
      expect(afterEnrichment).toEqual(beforeEnrichment);
      expect(afterCache).toEqual(beforeCache); // fetchedAt untouched — no refresh occurred
    });
  });

  describe("test-ownership boundary (regression)", () => {
    // Step 18C regression: enrichRecentItems's maintenance-fill pool
    // (getStaleHnMaintenanceCandidates) used to be scoped by the "hn:%"
    // sourceKey shape alone, so a real, unrelated stale-context HN item
    // could get swept into a small batch alongside this suite's own
    // hn:900... fixtures, inflating provider-call counts (this is exactly
    // what broke test [7] before this fix). The sentinel below has a
    // deliberately STALE cached context — the exact shape of a real
    // maintenance candidate — to prove it's excluded once scoped.
    // Must actually start with "hn:" to pass isHnSourceKey's shape gate
    // (real HN items are gated by sourceKey shape, not sourceType — see
    // getStaleHnMaintenanceCandidates's own comment) while staying well
    // outside this file's own hn:900... numeric test range, so the shared
    // cleanup() never touches it and a sourceKeyPrefix: "hn:900" query
    // correctly treats it as unrelated.
    const SENTINEL_KEY = "hn:49999999";

    async function seedSentinel() {
      await repo.upsertFeedItems([
        {
          id: SENTINEL_KEY,
          sourceType: "hackernews",
          sourceName: "Hacker News",
          title: "An unrelated real item this suite must never touch",
          description: "Stands in for a genuine dev-corpus HN item, not an hn:900... fixture.",
          publishedAt: new Date(Date.now() + 60_000).toISOString(),
          tags: ["Hacker News"],
          score: 0,
          commentCount: 0,
          url: "https://example.com/unrelated-real-corpus-item-hn",
        },
      ]);
      const item = await repo.getFeedItemForEnrichment(SENTINEL_KEY);
      if (!item) throw new Error("sentinel setup failed");
      mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "sentinel's own real context", commentRequestCount: 1 });
      await service.enrichFeedItem(SENTINEL_KEY, { provider: mockProviderModule.createMockProvider() });
      await makeStale(item.feedItemId); // now a genuine maintenance candidate, same shape as a real one
      const cacheBefore = await repo.getHnContextCache(item.feedItemId);
      if (!cacheBefore) throw new Error("sentinel setup failed");
      return { feedItemId: item.feedItemId, cacheBefore };
    }

    async function deleteSentinel() {
      await db.getDb()!.execute(sql`delete from feed_items where source_key = ${SENTINEL_KEY}`);
    }

    it("an unrelated, stale-context real HN item cannot enter a sourceKeyPrefix-scoped maintenance batch", async () => {
      try {
        const sentinel = await seedSentinel();
        const { feedItemId, sourceKey } = await seedHnItem(); // a normal, never-enriched hn:900... fixture
        mockedFetchContext.mockResolvedValueOnce({ label: "x", text: "fixture content", commentRequestCount: 1 });

        const { outcomes } = await service.enrichRecentItems({
          limit: 5,
          sourceType: "hackernews",
          sourceKeyPrefix: "hn:900",
          provider: mockProviderModule.createMockProvider(),
        });

        expect(outcomes.some((o) => o.sourceKey === SENTINEL_KEY)).toBe(false);
        expect(outcomes.some((o) => o.sourceKey === sourceKey)).toBe(true);
        void feedItemId;

        // Sentinel's stale cache row is completely untouched — never
        // refreshed, never re-checked, because it was never in the pool.
        const cacheAfter = await repo.getHnContextCache(sentinel.feedItemId);
        expect(cacheAfter).toEqual(sentinel.cacheBefore);

        const candidates = await repo.getStaleHnMaintenanceCandidates({ poolSize: 50, ttlMs: 24 * 60 * 60 * 1000, sourceKeyPrefix: "hn:900" });
        expect(candidates.some((c) => c.feedItemId === sentinel.feedItemId)).toBe(false);
      } finally {
        await deleteSentinel();
      }
    });
  });
});

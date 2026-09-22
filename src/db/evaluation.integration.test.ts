import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

/**
 * Integration tests for the Step 10 AI-quality evaluation harness against
 * a real PostgreSQL instance. Skipped entirely unless DATABASE_URL is
 * set. Every provider call here uses the deterministic mock provider (or
 * a hand-built fake that mimics specific failure modes) — this suite
 * never calls a real paid LLM; it verifies the HARNESS is correct, not
 * that mock-generated text is good quality (see Step 10 final report for
 * that distinction).
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("AI evaluation harness (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let schema: typeof import("@/db/schema");
  let selection: typeof import("@/lib/ai/evaluationSelection");
  let harness: typeof import("@/lib/ai/evaluationHarness");
  let service: typeof import("@/lib/ai/enrichmentService");
  let mockProviderModule: typeof import("@/lib/ai/mockProvider");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    schema = await import("@/db/schema");
    selection = await import("@/lib/ai/evaluationSelection");
    harness = await import("@/lib/ai/evaluationHarness");
    service = await import("@/lib/ai/enrichmentService");
    mockProviderModule = await import("@/lib/ai/mockProvider");
  });

  async function cleanup() {
    await db.getDb()!.execute(sql`delete from feed_items where source_key like 'evaltest:%'`);
  }
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(cleanup);

  let counter = 0;
  async function seed(overrides: Partial<Parameters<typeof repo.upsertFeedItems>[0][0]> = {}) {
    counter++;
    const id = overrides.id ?? `evaltest:${counter}`;
    await repo.upsertFeedItems([
      {
        sourceType: "hackernews",
        sourceName: "Hacker News",
        title: `Evaluation test item ${counter}`,
        description: "A normal description for evaluation testing.",
        publishedAt: new Date(Date.now() - counter * 1000).toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: `https://example.com/evaltest-${counter}`,
        ...overrides,
        id,
      },
    ]);
    return id;
  }

  describe("selectEvaluationSet — deterministic bucketed selection", () => {
    it("includes items from smaller source families even when one family has far more volume", async () => {
      // 6 Hacker News items would dominate a plain "newest N overall" pick.
      for (let i = 0; i < 6; i++) await seed({ sourceType: "hackernews", sourceName: "Hacker News" });
      await seed({ sourceType: "paper", sourceName: "arXiv" });
      await seed({
        sourceType: "github",
        sourceName: "GitHub",
        repositoryFullName: "evaltest/repo",
        owner: "evaltest",
      });
      await seed({ sourceType: "news", sourceName: "OpenAI", sourceId: "openai" });

      const items = await selection.selectEvaluationSet();
      const bucketLabels = new Set(items.map((i) => i.bucketLabel));
      expect(bucketLabels.has("arXiv")).toBe(true);
      expect(bucketLabels.has("GitHub")).toBe(true);
      expect(bucketLabels.has("OpenAI")).toBe(true);
      // Hacker News bucket is capped even though 6 were available.
      const hnCount = items.filter((i) => i.bucketLabel === "Hacker News").length;
      expect(hnCount).toBeLessThanOrEqual(3);
    });

    it("is reproducible against unchanged data", async () => {
      for (let i = 0; i < 4; i++) await seed();
      const a = await selection.selectEvaluationSet();
      const b = await selection.selectEvaluationSet();
      expect(a.map((i) => i.sourceKey)).toEqual(b.map((i) => i.sourceKey));
    });

    it("never exceeds the target maximum", async () => {
      for (let i = 0; i < 30; i++) await seed();
      const items = await selection.selectEvaluationSet();
      expect(items.length).toBeLessThanOrEqual(selection.EVALUATION_TARGET_MAX);
    });
  });

  describe("runEvaluation — structural correctness (mock provider)", () => {
    it("produces one result row per item with metrics and an empty human review", async () => {
      const key = await seed();
      const items = [{ sourceKey: key, bucketLabel: "Hacker News", item: await mustGetFeedItem(key) }];
      const report = await harness.runEvaluation(items, { provider: mockProviderModule.createMockProvider() });

      expect(report.results).toHaveLength(1);
      const [result] = report.results;
      expect(result.callOutcome).toBe("completed");
      expect(result.schemaValid).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.humanReview).toEqual({
        summaryFactuality: null,
        summaryUsefulness: null,
        topicCorrectness: null,
        relevanceScoreReasonable: null,
        notes: "",
      });
    });

    it("makes zero new provider calls on unchanged content the second time (cost control)", async () => {
      const key = await seed();
      const items = [{ sourceKey: key, bucketLabel: "Hacker News", item: await mustGetFeedItem(key) }];
      const provider = mockProviderModule.createMockProvider();

      const first = await harness.runEvaluation(items, { provider });
      const second = await harness.runEvaluation(items, { provider });

      expect(first.realProviderCallCount).toBe(1);
      expect(second.realProviderCallCount).toBe(0);
      expect(second.results[0].callOutcome).toBe("skipped_current");
    });

    it("classifies a provider failure without throwing out of the harness", async () => {
      const key = await seed();
      const items = [{ sourceKey: key, bucketLabel: "Hacker News", item: await mustGetFeedItem(key) }];
      const failingProvider = {
        name: "failing",
        model: "failing-v1",
        enrichArticle: async () => {
          const { ProviderError } = await import("@/lib/ai/types");
          throw new ProviderError("invalid_output", "simulated malformed output");
        },
      };

      const report = await harness.runEvaluation(items, { provider: failingProvider });
      expect(report.results[0].callOutcome).toBe("failed");
      expect(report.results[0].errorCode).toBe("invalid_output");
      expect(report.results[0].schemaValid).toBe(false);
    });
  });

  describe("runFullEvaluation — smoke test gating", () => {
    it("stops after a failing smoke test — no calls beyond the smoke size", async () => {
      const keys = [await seed(), await seed(), await seed(), await seed()];
      const items = await Promise.all(
        keys.map(async (k) => ({ sourceKey: k, bucketLabel: "Hacker News", item: await mustGetFeedItem(k) }))
      );

      let callCount = 0;
      const alwaysFailingProvider = {
        name: "failing",
        model: "failing-v1",
        enrichArticle: async () => {
          callCount++;
          const { ProviderError } = await import("@/lib/ai/types");
          throw new ProviderError("provider_error", "simulated auth failure");
        },
      };

      const result = await harness.runFullEvaluation(items, { provider: alwaysFailingProvider, smokeTestSize: 2 });
      expect(result.smokeTestPassed).toBe(false);
      expect(result.smokeTestFailureReason).toBe("provider_error");
      expect(callCount).toBe(2); // only the smoke-test items were attempted
      expect(result.report?.itemCount).toBe(2); // remaining 2 items never evaluated
    });

    it("proceeds to the full set when the smoke test passes", async () => {
      const keys = [await seed(), await seed(), await seed()];
      const items = await Promise.all(
        keys.map(async (k) => ({ sourceKey: k, bucketLabel: "Hacker News", item: await mustGetFeedItem(k) }))
      );

      const result = await harness.runFullEvaluation(items, {
        provider: mockProviderModule.createMockProvider(),
        smokeTestSize: 2,
      });
      expect(result.smokeTestPassed).toBe(true);
      expect(result.report?.itemCount).toBe(3);
      expect(result.report?.realProviderCallCount).toBe(3);
    });

    it("returns providerConfigured:false and makes zero calls when no provider is available", async () => {
      const key = await seed();
      const items = [{ sourceKey: key, bucketLabel: "Hacker News", item: await mustGetFeedItem(key) }];
      const result = await harness.runFullEvaluation(items, { provider: undefined });
      // No ANTHROPIC_API_KEY is set in this test environment.
      expect(result.providerConfigured).toBe(false);
      expect(result.smokeTestPassed).toBeNull();
      expect(result.report).toBeNull();
    });
  });

  describe("distribution statistics", () => {
    it("computes min/max/mean/median and relevance bands correctly", () => {
      const fakeReport = {
        generatedAt: new Date().toISOString(),
        promptVersion: "ai-news-v1",
        providerName: "mock",
        model: "mock-v1",
        itemCount: 4,
        realProviderCallCount: 4,
        totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null },
        results: [
          { sourceKey: "a", bucketLabel: "x", title: "a", sourceName: "S1", callOutcome: "completed" as const, schemaValid: true, relevanceScore: 0.1, humanReview: harnessEmptyReview() },
          { sourceKey: "b", bucketLabel: "x", title: "b", sourceName: "S1", callOutcome: "completed" as const, schemaValid: true, relevanceScore: 0.5, humanReview: harnessEmptyReview() },
          { sourceKey: "c", bucketLabel: "x", title: "c", sourceName: "S2", callOutcome: "completed" as const, schemaValid: true, relevanceScore: 0.8, humanReview: harnessEmptyReview() },
          { sourceKey: "d", bucketLabel: "x", title: "d", sourceName: "S2", callOutcome: "completed" as const, schemaValid: true, relevanceScore: 0.9, humanReview: harnessEmptyReview() },
        ],
      };
      const stats = harness.computeRelevanceStats(fakeReport);
      expect(stats.count).toBe(4);
      expect(stats.min).toBe(0.1);
      expect(stats.max).toBe(0.9);
      expect(stats.mean).toBeCloseTo(0.575, 5);
      expect(stats.median).toBeCloseTo(0.65, 5);
      expect(stats.byBand).toEqual({ high: 2, medium: 1, low: 1 });
      expect(stats.bySource.S1.count).toBe(2);
      expect(stats.bySource.S2.count).toBe(2);
    });

    it("returns a well-formed empty result when no items are scored", () => {
      const emptyReport = {
        generatedAt: new Date().toISOString(),
        promptVersion: "ai-news-v1",
        providerName: null,
        model: null,
        itemCount: 0,
        realProviderCallCount: 0,
        totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null },
        results: [],
      };
      const stats = harness.computeRelevanceStats(emptyReport);
      expect(stats).toEqual({ count: 0, min: null, max: null, mean: null, median: null, byBand: { high: 0, medium: 0, low: 0 }, bySource: {} });
    });

    it("computes topic frequency and the 'Other' rate", () => {
      const fakeReport = {
        generatedAt: new Date().toISOString(),
        promptVersion: "ai-news-v1",
        providerName: "mock",
        model: "mock-v1",
        itemCount: 2,
        realProviderCallCount: 2,
        totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null },
        results: [
          { sourceKey: "a", bucketLabel: "x", title: "a", sourceName: "S1", callOutcome: "completed" as const, schemaValid: true, topics: ["LLMs", "Agents"], humanReview: harnessEmptyReview() },
          { sourceKey: "b", bucketLabel: "x", title: "b", sourceName: "S1", callOutcome: "completed" as const, schemaValid: true, topics: ["Other"], humanReview: harnessEmptyReview() },
        ],
      };
      const stats = harness.computeTopicStats(fakeReport);
      expect(stats.totalTaggedItems).toBe(2);
      expect(stats.frequency["LLMs"]).toBe(1);
      expect(stats.frequency["Other"]).toBe(1);
      expect(stats.otherRate).toBeCloseTo(0.5, 5);
      expect(stats.averageTopicsPerItem).toBeCloseTo(1.5, 5);
    });
  });

  describe("report generation", () => {
    it("writes JSON and Markdown files with no secret material and a metadata-summary disclaimer", async () => {
      const key = await seed();
      const items = [{ sourceKey: key, bucketLabel: "Hacker News", item: await mustGetFeedItem(key) }];
      const report = await harness.runEvaluation(items, { provider: mockProviderModule.createMockProvider() });

      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs/promises");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-eval-test-"));

      const { jsonPath, mdPath } = await harness.writeEvaluationReport(report, dir);
      const jsonText = await fs.readFile(jsonPath, "utf8");
      const mdText = await fs.readFile(mdPath, "utf8");

      for (const text of [jsonText, mdText]) {
        expect(text).not.toContain("ANTHROPIC_API_KEY");
        expect(text).not.toMatch(/sk-ant-/);
        expect(text).not.toContain(process.env.DATABASE_URL ?? "__never__");
      }
      expect(mdText).toContain("metadata");
      expect(mdText.toLowerCase()).toContain("never read the full article");

      await fs.rm(dir, { recursive: true, force: true });
    });
  });

  describe("dry-run preview — zero calls, zero writes", () => {
    it("performs zero provider calls and zero database mutations", async () => {
      const key = await seed();
      const before = await countEnrichmentRows();

      const { items } = await service.previewEligibleCandidates({ limit: 5, sourceKeyPrefix: "evaltest:" });
      expect(items.some((i) => i.sourceKey === key)).toBe(true);

      const after = await countEnrichmentRows();
      expect(after).toBe(before);
    });

    it("reports cacheCurrent and wouldCallProvider correctly for an already-enriched item", async () => {
      const key = await seed();
      await service.enrichFeedItem(key, { provider: mockProviderModule.createMockProvider() });

      const { items } = await service.previewEligibleCandidates({ limit: 20, sourceKeyPrefix: "evaltest:" });
      const preview = items.find((i) => i.sourceKey === key);
      expect(preview?.cacheCurrent).toBe(true);
      // No real provider is configured in this test env, so wouldCallProvider
      // is false regardless of cache state — both conditions matter.
      expect(preview?.wouldCallProvider).toBe(false);
    });

    it("marks a current item as wouldCallProvider under --force, still with zero actual calls or writes", async () => {
      const key = await seed();
      await service.enrichFeedItem(key, { provider: mockProviderModule.createMockProvider() });
      const before = await countEnrichmentRows();

      const { items } = await service.previewEligibleCandidates({ limit: 20, sourceKeyPrefix: "evaltest:", force: true });
      const after = await countEnrichmentRows();
      expect(after).toBe(before);

      const preview = items.find((i) => i.sourceKey === key);
      expect(preview?.cacheCurrent).toBe(true);
      // wouldCallProvider still requires a configured provider; force only
      // changes whether a *current* item is eligible, not whether a
      // provider exists to call.
      expect(preview?.wouldCallProvider).toBe(false);
    });
  });

  describe("force re-enrichment", () => {
    it("reprocesses a current item under --force and still respects MAX_BATCH_LIMIT", async () => {
      const key = await seed();
      const provider = mockProviderModule.createMockProvider();
      await service.enrichFeedItem(key, { provider });

      let calls = 0;
      const countingProvider = {
        ...provider,
        enrichArticle: async (input: Parameters<typeof provider.enrichArticle>[0]) => {
          calls++;
          return provider.enrichArticle(input);
        },
      };

      const withoutForce = await service.enrichRecentItems({ limit: 5, sourceKeyPrefix: "evaltest:", provider: countingProvider });
      expect(withoutForce.outcomes).toHaveLength(0); // already current, nothing to do

      const withForce = await service.enrichRecentItems({ limit: 5, sourceKeyPrefix: "evaltest:", provider: countingProvider, force: true });
      expect(withForce.outcomes.some((o) => o.sourceKey === key && o.status === "completed")).toBe(true);
      expect(calls).toBe(1); // the forced re-run
    });

    it("a previously-failed item with unchanged content IS retried by a normal (non-force) batch run", async () => {
      // Regression check: earlier candidate-selection logic could
      // incorrectly treat "failed, hash unchanged" as cache-current and
      // skip it forever. It must remain eligible until it succeeds.
      const key = await seed();
      const failingProvider = {
        name: "failing",
        model: "failing-v1",
        enrichArticle: async () => {
          const { ProviderError } = await import("@/lib/ai/types");
          throw new ProviderError("provider_error", "simulated failure");
        },
      };
      await service.enrichFeedItem(key, { provider: failingProvider });

      const result = await service.enrichRecentItems({ limit: 5, sourceKeyPrefix: "evaltest:", provider: mockProviderModule.createMockProvider() });
      expect(result.outcomes.some((o) => o.sourceKey === key && o.status === "completed")).toBe(true);
    });
  });

  describe("status counts", () => {
    it("reflects real row counts grouped by status", async () => {
      const completedKey = await seed();
      const failedKey = await seed();
      await service.enrichFeedItem(completedKey, { provider: mockProviderModule.createMockProvider() });
      const failingProvider = {
        name: "failing",
        model: "failing-v1",
        enrichArticle: async () => {
          const { ProviderError } = await import("@/lib/ai/types");
          throw new ProviderError("invalid_output", "simulated");
        },
      };
      await service.enrichFeedItem(failedKey, { provider: failingProvider });

      const counts = await repo.getEnrichmentStatusCounts();
      expect(counts.completed).toBeGreaterThanOrEqual(1);
      expect(counts.failed).toBeGreaterThanOrEqual(1);
    });
  });

  describe("security", () => {
    it("the article_enrichments schema has no column capable of storing a raw HTTP payload or secret", async () => {
      const columns = await db
        .getDb()!
        .execute(sql`select column_name from information_schema.columns where table_name = 'article_enrichments'`);
      const names = (columns as unknown as { column_name: string }[]).map((c) => c.column_name);
      for (const forbidden of ["raw_response", "api_key", "authorization", "headers", "request_body"]) {
        expect(names).not.toContain(forbidden);
      }
    });
  });

  describe("test-ownership boundary (regression)", () => {
    // Step 18C regression: enrichRecentItems's candidate pool used to be
    // scoped by sourceType alone, so an already-current real corpus item
    // could get swept into a small --force batch and reprocessed. The
    // sentinel is future-dated so it sorts first in an unscoped pool.
    const SENTINEL_KEY = "unrelated-real-corpus-item:eval-sentinel";

    async function seedSentinel() {
      await repo.upsertFeedItems([
        {
          id: SENTINEL_KEY,
          sourceType: "hackernews",
          sourceName: "Hacker News",
          title: "An unrelated real item this suite must never touch",
          description: "Stands in for a genuine dev-corpus item, not an evaltest: fixture.",
          publishedAt: new Date(Date.now() + 60_000).toISOString(),
          tags: [],
          score: 0,
          commentCount: 0,
          url: "https://example.com/unrelated-real-corpus-item-eval",
        },
      ]);
      const item = await repo.getFeedItemForEnrichment(SENTINEL_KEY);
      if (!item) throw new Error("sentinel setup failed");
      const feedItemId = item.feedItemId;
      await service.enrichFeedItem(SENTINEL_KEY, { provider: mockProviderModule.createMockProvider() });
      const before = await repo.getEnrichmentByFeedItemId(feedItemId);
      if (!before) throw new Error("sentinel setup failed");
      return { feedItemId, record: before };
    }

    async function deleteSentinel() {
      await db.getDb()!.execute(sql`delete from feed_items where source_key = ${SENTINEL_KEY}`);
    }

    it("an unrelated, already-current real item cannot enter a sourceKeyPrefix-scoped --force batch", async () => {
      try {
        const sentinel = await seedSentinel();
        const key = await seed();
        const provider = mockProviderModule.createMockProvider();
        await service.enrichFeedItem(key, { provider });

        const { outcomes } = await service.enrichRecentItems({
          limit: 10,
          sourceKeyPrefix: "evaltest:",
          provider,
          force: true,
        });

        expect(outcomes.some((o) => o.sourceKey === SENTINEL_KEY)).toBe(false);
        expect(outcomes.some((o) => o.sourceKey === key)).toBe(true);

        const after = await repo.getEnrichmentByFeedItemId(sentinel.feedItemId);
        expect(after).toEqual(sentinel.record); // byte-for-byte untouched
      } finally {
        await deleteSentinel();
      }
    });
  });

  // --- local helpers ---

  async function mustGetFeedItem(sourceKey: string) {
    const rows = await db
      .getDb()!
      .select()
      .from(schema.feedItems)
      .where(sql`source_key = ${sourceKey}`)
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`test setup: ${sourceKey} not found`);
    return repo.rowToFeedItem(row);
  }

  async function countEnrichmentRows(): Promise<number> {
    const [{ count }] = await db
      .getDb()!
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.articleEnrichments);
    return count;
  }

  function harnessEmptyReview() {
    return { summaryFactuality: null, summaryUsefulness: null, topicCorrectness: null, relevanceScoreReasonable: null, notes: "" };
  }
});

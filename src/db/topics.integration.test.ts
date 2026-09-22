import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { AiTopic } from "@/lib/ai/taxonomy";

/**
 * Step 20 — integration tests for the Topics data layer:
 * `getFeedItemsForTopics` (the one bounded, time-windowed DB fetch) and
 * `aggregateTopics`/`findTopicBySlug` (the pure in-process grouping) used
 * together exactly as `/topics` and `/topics/[slug]` do. Skipped entirely
 * unless DATABASE_URL is set. Never calls a real AI/embedding provider —
 * enrichment topics here come from the deterministic mock provider only.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const TEST_SOURCE_KEY_PREFIX = "topicstest:";

describeIfDb("Topics data layer (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let topicsModule: typeof import("@/lib/topics");
  let enrichmentService: typeof import("@/lib/ai/enrichmentService");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    topicsModule = await import("@/lib/topics");
    enrichmentService = await import("@/lib/ai/enrichmentService");
  });

  async function cleanup() {
    await db.getDb()!.execute(sql`delete from feed_items where source_key like ${TEST_SOURCE_KEY_PREFIX + "%"}`);
  }
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(cleanup);

  let counter = 0;
  async function seedItem(
    daysAgo: number,
    overrides: Partial<Parameters<typeof repo.upsertFeedItems>[0][0]> = {}
  ) {
    counter++;
    const id = overrides.id ?? `${TEST_SOURCE_KEY_PREFIX}${counter}`;
    await repo.upsertFeedItems([
      {
        sourceType: "github",
        sourceName: "GitHub",
        title: `Topics test item ${counter}`,
        description: "desc",
        publishedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        tags: [],
        score: 0,
        commentCount: 0,
        url: `https://example.com/topicstest-${counter}`,
        ...overrides,
        id,
      },
    ]);
    const found = await repo.getFeedItemForEnrichment(id);
    if (!found) throw new Error("test setup failed");
    return { sourceKey: id, feedItemId: found.feedItemId };
  }

  describe("getFeedItemsForTopics — time window", () => {
    it("includes items within the window and excludes items older than it", async () => {
      await seedItem(2, { tags: ["topicstest-signal"] });
      await seedItem(45, { tags: ["topicstest-signal"] });

      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      const ourRows = rows.filter((r) => r.item.id.startsWith(TEST_SOURCE_KEY_PREFIX));
      expect(ourRows).toHaveLength(1);
      expect(ourRows[0].tags).toContain("topicstest-signal");
    });

    it("excludes items with no tags and no enrichment topics", async () => {
      await seedItem(1, { tags: [] });
      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      const ourRows = rows.filter((r) => r.item.id.startsWith(TEST_SOURCE_KEY_PREFIX));
      expect(ourRows).toHaveLength(0);
    });
  });

  describe("canonical slug + membership, against real data", () => {
    it("groups two items whose raw tags differ only in casing/whitespace under one canonical slug", async () => {
      await seedItem(1, { tags: ["Topics-Test Signal"] });
      await seedItem(1, { tags: ["topics-test-signal"] });

      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      const topics = topicsModule.aggregateTopics(rows);
      const topic = topicsModule.findTopicBySlug(topics, "topics-test-signal");

      expect(topic).toBeDefined();
      expect(topic!.totalCount).toBeGreaterThanOrEqual(2);
      const ourItems = topic!.items.filter((i) => i.id.startsWith(TEST_SOURCE_KEY_PREFIX));
      expect(ourItems).toHaveLength(2);
    });

    it("excludes items tagged with a genuinely unrelated topic", async () => {
      const { feedItemId: relatedId } = await seedItem(1, { tags: ["topicstest-alpha"] });
      await seedItem(1, { tags: ["topicstest-beta"] });

      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      const topics = topicsModule.aggregateTopics(rows);
      const alpha = topicsModule.findTopicBySlug(topics, "topicstest-alpha");

      expect(alpha).toBeDefined();
      expect(alpha!.items.some((i) => i.dbId === relatedId)).toBe(true);
      expect(alpha!.items.some((i) => i.tags?.includes("topicstest-beta"))).toBe(false);
    });

    it("surfaces genuine cross-source composition when the same tag appears across source types", async () => {
      await seedItem(1, { sourceType: "github", sourceName: "GitHub", tags: ["topicstest-cross"] });
      await seedItem(1, { sourceType: "paper", sourceName: "arXiv", tags: ["topicstest-cross"] });
      await seedItem(1, {
        sourceType: "news",
        sourceName: "Test Publisher",
        sourceId: "test-publisher",
        tags: ["topicstest-cross"],
      });

      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      const topics = topicsModule.aggregateTopics(rows);
      const topic = topicsModule.findTopicBySlug(topics, "topicstest-cross");

      expect(topic).toBeDefined();
      expect(topic!.sourceTypeCounts.github).toBe(1);
      expect(topic!.sourceTypeCounts.paper).toBe(1);
      expect(topic!.sourceTypeCounts.news).toBe(1);
    });
  });

  describe("the two-tier existence check used by the /topics/[slug] route", () => {
    it("a topic with items only outside the narrow window still 'exists' at the wide window", async () => {
      await seedItem(20, { tags: ["topicstest-wideonly"] });

      const narrowRows = await repo.getFeedItemsForTopics({ sinceDays: 7 });
      const narrowTopic = topicsModule.findTopicBySlug(topicsModule.aggregateTopics(narrowRows), "topicstest-wideonly");
      expect(narrowTopic).toBeUndefined(); // empty-for-this-window, not missing

      const wideRows = await repo.getFeedItemsForTopics({ sinceDays: topicsModule.MAX_TOPIC_WINDOW_DAYS });
      const wideTopic = topicsModule.findTopicBySlug(topicsModule.aggregateTopics(wideRows), "topicstest-wideonly");
      expect(wideTopic).toBeDefined(); // exists — the route must render the empty state, not 404
    });

    it("a slug with no matching items at any window is genuinely not found", async () => {
      const wideRows = await repo.getFeedItemsForTopics({ sinceDays: topicsModule.MAX_TOPIC_WINDOW_DAYS });
      const found = topicsModule.findTopicBySlug(topicsModule.aggregateTopics(wideRows), "topicstest-does-not-exist-anywhere");
      expect(found).toBeUndefined(); // the route's real notFound() trigger
    });
  });

  describe("zero-enrichment vs. legitimate enrichment topic signal", () => {
    it("zero-enrichment: aggregation works from tags alone when no enrichment exists", async () => {
      await seedItem(1, { tags: ["topicstest-noenrichment"] });
      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      const ourRow = rows.find((r) => r.tags.includes("topicstest-noenrichment"));
      expect(ourRow?.enrichmentTopics).toBeNull();

      const topic = topicsModule.findTopicBySlug(topicsModule.aggregateTopics(rows), "topicstest-noenrichment");
      expect(topic?.hasEnrichmentSignal).toBe(false);
    });

    it("legitimate enrichment: a completed enrichment's controlled-taxonomy topic contributes to aggregation", async () => {
      // Real enrichment topics come from a fixed, closed taxonomy
      // (src/lib/ai/taxonomy.ts's AI_TOPICS), never freeform text — using
      // one of those exact values here ("Agents") is what a real provider
      // call could actually produce, not a synthetic string.
      const { sourceKey } = await seedItem(1, { tags: [] });
      const provider = {
        name: "mock",
        model: "mock-deterministic-v1",
        enrichArticle: async () => ({
          output: { summary: "A test summary.", topics: ["Agents"] as AiTopic[], relevanceScore: 0.5 },
        }),
      };
      const outcome = await enrichmentService.enrichFeedItem(sourceKey, { provider });
      expect(outcome.status).toBe("completed");

      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      const topic = topicsModule.findTopicBySlug(topicsModule.aggregateTopics(rows), "agents");
      expect(topic).toBeDefined();
      expect(topic!.hasEnrichmentSignal).toBe(true);
    });

    it("a real controlled-taxonomy enrichment topic joins the SAME topic as a tag-derived one for the same concept", async () => {
      // Demonstrates the milestone's own framing directly: when legitimate
      // enrichment exists, it participates as an ADDITIONAL signal on the
      // exact same normalized slug a source-native tag already produces —
      // no special-casing needed, both flow through one normalization path.
      const { feedItemId: taggedId } = await seedItem(1, { tags: ["agents"] });
      const { sourceKey: enrichedKey, feedItemId: enrichedId } = await seedItem(1, { tags: [] });
      const provider = {
        name: "mock",
        model: "mock-deterministic-v1",
        enrichArticle: async () => ({
          output: { summary: "A test summary.", topics: ["Agents"] as AiTopic[], relevanceScore: 0.5 },
        }),
      };
      await enrichmentService.enrichFeedItem(enrichedKey, { provider });

      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      const topic = topicsModule.findTopicBySlug(topicsModule.aggregateTopics(rows), "agents");
      expect(topic).toBeDefined();
      const ids = topic!.items.map((i) => i.dbId);
      expect(ids).toContain(taggedId);
      expect(ids).toContain(enrichedId);
    });
  });

  describe("cost/network boundary", () => {
    it("makes zero embedding-provider calls — Topics never touches embeddings at all", async () => {
      await seedItem(1, { tags: ["topicstest-noembeddingcall"] });

      const openaiEmbeddingModule = await import("@/lib/ai/openaiEmbeddingProvider");
      const embedSpy = vi.spyOn(openaiEmbeddingModule, "createOpenAiEmbeddingProvider");
      const openaiEnrichModule = await import("@/lib/ai/openaiProvider");
      const enrichSpy = vi.spyOn(openaiEnrichModule, "createOpenAiProvider");

      const rows = await repo.getFeedItemsForTopics({ sinceDays: 30 });
      topicsModule.aggregateTopics(rows);

      expect(embedSpy).not.toHaveBeenCalled();
      expect(enrichSpy).not.toHaveBeenCalled();
      embedSpy.mockRestore();
      enrichSpy.mockRestore();
    });
  });
});

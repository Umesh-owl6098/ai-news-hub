import { describe, expect, it } from "vitest";
import { normalizeTopicSlug, normalizeTopicTag, aggregateTopics, findTopicBySlug, type TopicSourceInput } from "@/lib/topics";
import type { FeedItem, SourceType } from "@/types/feed";

function makeItem(overrides: Partial<FeedItem> & { id: string; sourceType: SourceType }): FeedItem {
  return {
    sourceName: "Test Source",
    title: `Item ${overrides.id}`,
    description: "desc",
    publishedAt: "2026-09-15T00:00:00.000Z",
    tags: [],
    score: 0,
    commentCount: 0,
    url: `https://example.com/${overrides.id}`,
    dbId: Number(overrides.id.replace(/\D/g, "")) || 1,
    ...overrides,
  };
}

function input(item: FeedItem, tags: string[], enrichmentTopics: string[] | null = null): TopicSourceInput {
  return { feedItemId: item.dbId!, item, tags, enrichmentTopics };
}

describe("normalizeTopicSlug", () => {
  it("lowercases and trims", () => {
    expect(normalizeTopicSlug("  Machine Intelligence  ")).toBe("machine-intelligence");
  });

  it("collapses whitespace and underscores to a single hyphen", () => {
    expect(normalizeTopicSlug("machine   learning_ops")).toBe("machine-learning-ops");
  });

  it("collapses repeated hyphens and strips leading/trailing ones", () => {
    expect(normalizeTopicSlug("--ai--agents--")).toBe("ai-agents");
  });

  it("leaves already-kebab-case GitHub-style tags unchanged in shape", () => {
    expect(normalizeTopicSlug("ai-agents")).toBe("ai-agents");
  });

  it("preserves arXiv category dots", () => {
    expect(normalizeTopicSlug("cs.AI")).toBe("cs.ai");
  });
});

describe("normalizeTopicTag", () => {
  it("excludes the confirmed Hacker News placeholder tag", () => {
    expect(normalizeTopicTag({ raw: "Hacker News", sourceType: "hackernews" })).toBeNull();
    expect(normalizeTopicTag({ raw: "hacker news", sourceType: "hackernews" })).toBeNull();
  });

  it("excludes empty/whitespace-only tags", () => {
    expect(normalizeTopicTag({ raw: "   ", sourceType: "github" })).toBeNull();
  });

  it("applies the explicit singular/plural alias map for confirmed near-duplicates", () => {
    expect(normalizeTopicTag({ raw: "agent", sourceType: "github" })?.slug).toBe("agents");
    expect(normalizeTopicTag({ raw: "ai-agent", sourceType: "github" })?.slug).toBe("ai-agents");
    expect(normalizeTopicTag({ raw: "agents", sourceType: "github" })?.slug).toBe("agents");
  });

  it("does NOT merge genuinely different compound phrases", () => {
    const a = normalizeTopicTag({ raw: "agents", sourceType: "github" });
    const b = normalizeTopicTag({ raw: "agentic-ai", sourceType: "github" });
    const c = normalizeTopicTag({ raw: "agentic-framework", sourceType: "github" });
    expect(a?.slug).not.toBe(b?.slug);
    expect(b?.slug).not.toBe(c?.slug);
  });

  it("looks up a known arXiv category code into a readable display label", () => {
    const result = normalizeTopicTag({ raw: "cs.AI", sourceType: "paper" });
    expect(result?.slug).toBe("cs.ai");
    expect(result?.displayLabel).toBe("Artificial Intelligence (cs.AI)");
  });

  it("falls back to the raw code for an unknown arXiv-shaped category", () => {
    const result = normalizeTopicTag({ raw: "cs.ZZ", sourceType: "paper" });
    expect(result?.slug).toBe("cs.zz");
    expect(result?.displayLabel).toBe("cs.ZZ");
  });

  it("keeps GitHub/News tags as their own raw text (no arXiv lookup applied)", () => {
    expect(normalizeTopicTag({ raw: "ai-agents", sourceType: "github" })?.displayLabel).toBe("ai-agents");
    expect(normalizeTopicTag({ raw: "Machine Intelligence", sourceType: "news" })?.displayLabel).toBe("Machine Intelligence");
  });
});

describe("aggregateTopics", () => {
  it("groups items sharing a normalized tag into one topic with the correct count", () => {
    const a = makeItem({ id: "1", sourceType: "github" });
    const b = makeItem({ id: "2", sourceType: "github" });
    const topics = aggregateTopics([input(a, ["ai-agents"]), input(b, ["AI-Agents"])]);

    expect(topics).toHaveLength(1);
    expect(topics[0].slug).toBe("ai-agents");
    expect(topics[0].totalCount).toBe(2);
  });

  it("counts an item once even if it carries two raw tags that alias to the same slug", () => {
    const a = makeItem({ id: "1", sourceType: "github" });
    const topics = aggregateTopics([input(a, ["agent", "agents"])]);
    expect(topics).toHaveLength(1);
    expect(topics[0].totalCount).toBe(1);
  });

  it("computes source-type and publisher diversity correctly", () => {
    const gh = makeItem({ id: "1", sourceType: "github", sourceName: "GitHub" });
    const paper = makeItem({ id: "2", sourceType: "paper", sourceName: "arXiv" });
    const newsA = makeItem({ id: "3", sourceType: "news", sourceName: "OpenAI", sourceId: "openai" });
    const newsB = makeItem({ id: "4", sourceType: "news", sourceName: "Hugging Face", sourceId: "huggingface" });

    const topics = aggregateTopics([
      input(gh, ["agents"]),
      input(paper, ["agents"]),
      input(newsA, ["agents"]),
      input(newsB, ["agents"]),
    ]);

    expect(topics[0].sourceTypeCounts).toEqual({ github: 1, paper: 1, news: 2 });
    expect(topics[0].distinctPublisherCount).toBe(4); // GitHub, arXiv, openai, huggingface
  });

  it("a topic appearing only in one source type is still a fully valid topic", () => {
    const a = makeItem({ id: "1", sourceType: "paper" });
    const b = makeItem({ id: "2", sourceType: "paper" });
    const topics = aggregateTopics([input(a, ["cs.AI"]), input(b, ["cs.AI"])]);
    expect(topics).toHaveLength(1);
    expect(topics[0].totalCount).toBe(2);
    expect(topics[0].sourceTypeCounts).toEqual({ paper: 2 });
  });

  it("sorts topics by total count descending, ties broken by slug", () => {
    const a = makeItem({ id: "1", sourceType: "github" });
    const b = makeItem({ id: "2", sourceType: "github" });
    const c = makeItem({ id: "3", sourceType: "github" });
    const topics = aggregateTopics([input(a, ["zebra"]), input(b, ["alpha"]), input(c, ["alpha"])]);
    expect(topics.map((t) => t.slug)).toEqual(["alpha", "zebra"]);
  });

  it("picks the most frequently occurring original label as the display label", () => {
    const a = makeItem({ id: "1", sourceType: "github" });
    const b = makeItem({ id: "2", sourceType: "github" });
    const c = makeItem({ id: "3", sourceType: "github" });
    // "AI Agents" appears twice, "ai agents" once -> the former should win.
    const topics = aggregateTopics([input(a, ["AI Agents"]), input(b, ["AI Agents"]), input(c, ["ai agents"])]);
    expect(topics[0].label).toBe("AI Agents");
  });

  it("zero-enrichment operation: works correctly with enrichmentTopics always null", () => {
    const a = makeItem({ id: "1", sourceType: "github" });
    const topics = aggregateTopics([input(a, ["agents"], null)]);
    expect(topics[0].hasEnrichmentSignal).toBe(false);
    expect(topics[0].totalCount).toBe(1);
  });

  it("legitimate enrichment topics contribute as an additional signal and set hasEnrichmentSignal", () => {
    const a = makeItem({ id: "1", sourceType: "news" });
    const topics = aggregateTopics([input(a, [], ["Retrieval Augmented Generation"])]);
    expect(topics).toHaveLength(1);
    expect(topics[0].slug).toBe("retrieval-augmented-generation");
    expect(topics[0].hasEnrichmentSignal).toBe(true);
  });

  it("sorts each topic's items most-recent-first", () => {
    const older = makeItem({ id: "1", sourceType: "github", publishedAt: "2026-09-01T00:00:00.000Z" });
    const newer = makeItem({ id: "2", sourceType: "github", publishedAt: "2026-09-14T00:00:00.000Z" });
    const topics = aggregateTopics([input(older, ["agents"]), input(newer, ["agents"])]);
    expect(topics[0].items.map((i) => i.dbId)).toEqual([2, 1]);
  });

  it("excludes items with no usable tags entirely (nothing to group them under)", () => {
    const tagged = makeItem({ id: "1", sourceType: "github" });
    const untagged = makeItem({ id: "2", sourceType: "news" });
    const topics = aggregateTopics([input(tagged, ["agents"]), input(untagged, [])]);
    expect(topics).toHaveLength(1);
    expect(topics.flatMap((t) => t.items.map((i) => i.dbId))).not.toContain(untagged.dbId);
  });

  it("excludes Hacker News's constant placeholder tag from ever forming a topic", () => {
    const hn = makeItem({ id: "1", sourceType: "hackernews" });
    const topics = aggregateTopics([input(hn, ["Hacker News"])]);
    expect(topics).toHaveLength(0);
  });
});

describe("findTopicBySlug", () => {
  it("finds the matching topic by exact slug", () => {
    const a = makeItem({ id: "1", sourceType: "github" });
    const b = makeItem({ id: "2", sourceType: "paper" });
    const topics = aggregateTopics([input(a, ["ai-agents"]), input(b, ["cs.AI"])]);

    const found = findTopicBySlug(topics, "cs.ai");
    expect(found?.slug).toBe("cs.ai");
    expect(found?.items.map((i) => i.dbId)).toEqual([2]);
  });

  it("returns undefined for a slug with no matching topic (not-found trigger)", () => {
    const topics = aggregateTopics([input(makeItem({ id: "1", sourceType: "github" }), ["agents"])]);
    expect(findTopicBySlug(topics, "does-not-exist")).toBeUndefined();
  });
});

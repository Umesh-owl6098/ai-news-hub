import { describe, expect, it } from "vitest";
import {
  buildBriefing,
  summarizeSourceFreshness,
  TOP_STORIES_LIMIT,
  MAX_PER_SOURCE_TYPE_IN_TOP_STORIES,
  RESEARCH_LIMIT,
  PROJECTS_LIMIT,
  NEWS_AND_DISCUSSION_LIMIT,
  BRIEFING_STALE_THRESHOLD_MS,
} from "@/lib/briefing";
import type { FeedItem, SourceType } from "@/types/feed";
import type { SourceHealthSummary } from "@/db/repository";

const NOW = new Date("2026-09-16T12:00:00.000Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

let counter = 0;
function makeItem(sourceType: SourceType, overrides: Partial<FeedItem> = {}): FeedItem {
  counter += 1;
  const id = overrides.id ?? `${sourceType}:${counter}`;
  return {
    id,
    sourceType,
    sourceName: sourceType,
    title: `Item ${id}`,
    description: "desc",
    publishedAt: hoursAgo(1),
    tags: [],
    score: 0,
    commentCount: 0,
    url: `https://example.com/${id}`,
    dbId: counter,
    ...overrides,
  };
}

function makeHealth(overrides: Partial<SourceHealthSummary> & { sourceKey: string }): SourceHealthSummary {
  return {
    sourceLabel: overrides.sourceKey,
    lastAttemptedAt: null,
    lastSucceededAt: null,
    lastSuccessItemCount: null,
    lastStatus: "never_run",
    lastErrorCategory: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

describe("buildBriefing — empty/sparse corpus", () => {
  it("returns all-empty sections for an empty pool", () => {
    const sections = buildBriefing([], { now: NOW });
    expect(sections).toEqual({ topStories: [], research: [], projects: [], newsAndDiscussion: [] });
  });

  it("handles a single-source corpus: caps that source in Top Stories, fills Projects with the remainder", () => {
    const items = Array.from({ length: 10 }, () => makeItem("github", { publishedAt: hoursAgo(1) }));
    const sections = buildBriefing(items, { now: NOW });

    expect(sections.topStories).toHaveLength(MAX_PER_SOURCE_TYPE_IN_TOP_STORIES);
    expect(sections.research).toHaveLength(0);
    expect(sections.newsAndDiscussion).toHaveLength(0);
    // The rest (10 - 2 used in Top Stories) fill Projects, capped at PROJECTS_LIMIT.
    expect(sections.projects.length).toBe(Math.min(PROJECTS_LIMIT, 10 - MAX_PER_SOURCE_TYPE_IN_TOP_STORIES));
  });

  it("leaves a section empty when its source type has zero eligible items, rather than forcing content", () => {
    const items = [makeItem("github", { publishedAt: hoursAgo(1) }), makeItem("hackernews", { publishedAt: hoursAgo(1) })];
    const sections = buildBriefing(items, { now: NOW });
    expect(sections.research).toEqual([]);
  });
});

describe("buildBriefing — recency/window boundary", () => {
  it("includes an item published just inside the window and excludes one just outside it", () => {
    const windowHours = 72;
    const justInside = makeItem("paper", { publishedAt: hoursAgo(windowHours - 0.01) });
    const justOutside = makeItem("paper", { publishedAt: hoursAgo(windowHours + 0.01) });

    const sections = buildBriefing([justInside, justOutside], { now: NOW, windowHours });
    const allIds = [...sections.topStories, ...sections.research].map((i) => i.id);
    expect(allIds).toContain(justInside.id);
    expect(allIds).not.toContain(justOutside.id);
  });

  it("excludes an item published exactly at the cutoff (strictly-after semantics)", () => {
    const windowHours = 72;
    const exactlyAtCutoff = makeItem("paper", { publishedAt: hoursAgo(windowHours) });
    const sections = buildBriefing([exactlyAtCutoff], { now: NOW, windowHours });
    expect(sections.research).toEqual([]);
  });

  // --- Step 28: the reference instant is an upper bound too --------------

  it("includes an item published exactly AT the reference instant (inclusive upper bound)", () => {
    const exactlyAtNow = makeItem("paper", { publishedAt: NOW.toISOString() });
    const sections = buildBriefing([exactlyAtNow], { now: NOW });
    const allIds = [...sections.topStories, ...sections.research].map((i) => i.id);
    expect(allIds).toContain(exactlyAtNow.id);
  });

  it("excludes an item published one millisecond after the reference instant", () => {
    const oneMsAfter = makeItem("paper", { publishedAt: new Date(NOW.getTime() + 1).toISOString() });
    const sections = buildBriefing([oneMsAfter], { now: NOW });
    expect(sections.research).toEqual([]);
  });

  it("excludes an item published well after the reference instant, even though it's within the window relative to the real 'now'", () => {
    // Simulates historical reconstruction: `NOW` here plays the role of a
    // past reference instant, and this item is "from the future" relative
    // to it (e.g. published today, while reconstructing a briefing for
    // last week) — must never leak into a historical briefing.
    const publishedLater = makeItem("github", { publishedAt: hoursAgo(-24) }); // 24h after NOW
    const sections = buildBriefing([publishedLater], { now: NOW });
    const allIds = [...sections.topStories, ...sections.projects].map((i) => i.id);
    expect(allIds).not.toContain(publishedLater.id);
  });

  it("a historical reference instant (not the real current time) still applies the full 72h window correctly", () => {
    const historicalNow = new Date("2026-06-15T23:59:59.999Z");
    const withinWindow = makeItem("paper", { publishedAt: "2026-06-14T10:00:00.000Z" }); // ~38h before
    const beforeWindow = makeItem("paper", { publishedAt: "2026-06-12T10:00:00.000Z" }); // ~86h before
    const afterReferenceInstant = makeItem("paper", { publishedAt: "2026-06-16T10:00:00.000Z" });

    const sections = buildBriefing([withinWindow, beforeWindow, afterReferenceInstant], { now: historicalNow });
    const ids = [...sections.topStories, ...sections.research].map((i) => i.id);
    expect(ids).toContain(withinWindow.id);
    expect(ids).not.toContain(beforeWindow.id);
    expect(ids).not.toContain(afterReferenceInstant.id);
  });

  it("repeated calls with the same pool and the same reference instant produce identical output (deterministic)", () => {
    const items = [
      makeItem("paper", { publishedAt: hoursAgo(10) }),
      makeItem("github", { publishedAt: hoursAgo(20) }),
      makeItem("hackernews", { publishedAt: hoursAgo(5) }),
    ];
    const first = buildBriefing(items, { now: NOW });
    const second = buildBriefing(items, { now: NOW });
    expect(second).toEqual(first);
  });
});

describe("buildBriefing — Top Stories source diversity", () => {
  it("never lets one source type exceed MAX_PER_SOURCE_TYPE_IN_TOP_STORIES", () => {
    const items = [
      ...Array.from({ length: 8 }, () => makeItem("github", { publishedAt: hoursAgo(1) })),
      makeItem("hackernews", { publishedAt: hoursAgo(2) }),
      makeItem("paper", { publishedAt: hoursAgo(3) }),
      makeItem("news", { publishedAt: hoursAgo(4) }),
    ];
    const sections = buildBriefing(items, { now: NOW });

    const perType = new Map<SourceType, number>();
    for (const item of sections.topStories) perType.set(item.sourceType, (perType.get(item.sourceType) ?? 0) + 1);
    for (const [, count] of perType) expect(count).toBeLessThanOrEqual(MAX_PER_SOURCE_TYPE_IN_TOP_STORIES);
    // With one candidate each from hackernews/paper/news plus the github
    // cap, Top Stories should include all three non-dominant types.
    expect(perType.get("hackernews")).toBe(1);
    expect(perType.get("paper")).toBe(1);
    expect(perType.get("news")).toBe(1);
  });

  it("orders Top Stories primarily by recency within the diversity cap", () => {
    const oldest = makeItem("github", { publishedAt: hoursAgo(10) });
    const middle = makeItem("hackernews", { publishedAt: hoursAgo(5) });
    const newest = makeItem("paper", { publishedAt: hoursAgo(1) });
    const sections = buildBriefing([oldest, middle, newest], { now: NOW });
    expect(sections.topStories.map((i) => i.id)).toEqual([newest.id, middle.id, oldest.id]);
  });
});

describe("buildBriefing — max item counts", () => {
  it("caps every section at its documented limit", () => {
    const items = [
      ...Array.from({ length: 20 }, () => makeItem("github", { publishedAt: hoursAgo(1) })),
      ...Array.from({ length: 20 }, () => makeItem("paper", { publishedAt: hoursAgo(1) })),
      ...Array.from({ length: 20 }, () => makeItem("hackernews", { publishedAt: hoursAgo(1) })),
    ];
    const sections = buildBriefing(items, { now: NOW });
    expect(sections.topStories.length).toBeLessThanOrEqual(TOP_STORIES_LIMIT);
    expect(sections.research.length).toBeLessThanOrEqual(RESEARCH_LIMIT);
    expect(sections.projects.length).toBeLessThanOrEqual(PROJECTS_LIMIT);
    expect(sections.newsAndDiscussion.length).toBeLessThanOrEqual(NEWS_AND_DISCUSSION_LIMIT);
  });
});

describe("buildBriefing — no duplicate items across sections", () => {
  it("never places the same item in Top Stories and its type-specific section", () => {
    const items = Array.from({ length: 15 }, () => makeItem("paper", { publishedAt: hoursAgo(1) }));
    const sections = buildBriefing(items, { now: NOW });
    const topIds = new Set(sections.topStories.map((i) => i.id));
    const researchIds = sections.research.map((i) => i.id);
    for (const id of researchIds) expect(topIds.has(id)).toBe(false);
  });

  it("has zero overlap across all four sections for a large mixed pool", () => {
    const items = [
      ...Array.from({ length: 10 }, () => makeItem("github", { publishedAt: hoursAgo(1) })),
      ...Array.from({ length: 10 }, () => makeItem("paper", { publishedAt: hoursAgo(1) })),
      ...Array.from({ length: 10 }, () => makeItem("hackernews", { publishedAt: hoursAgo(1) })),
      ...Array.from({ length: 10 }, () => makeItem("news", { publishedAt: hoursAgo(1) })),
    ];
    const sections = buildBriefing(items, { now: NOW });
    const all = [...sections.topStories, ...sections.research, ...sections.projects, ...sections.newsAndDiscussion];
    const ids = all.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildBriefing — News & Discussion groups RSS and Hacker News", () => {
  it("includes both news and hackernews source types, excludes github/paper", () => {
    // More news/hackernews items than Top Stories' per-type cap can
    // absorb, so some are left over for this section to actually exercise
    // (with too few items, Top Stories alone would swallow the whole pool).
    const items = [
      ...Array.from({ length: 4 }, () => makeItem("news", { publishedAt: hoursAgo(1) })),
      ...Array.from({ length: 4 }, () => makeItem("hackernews", { publishedAt: hoursAgo(2) })),
      makeItem("github", { publishedAt: hoursAgo(3) }),
      makeItem("paper", { publishedAt: hoursAgo(4) }),
    ];
    const sections = buildBriefing(items, { now: NOW });
    const types = new Set(sections.newsAndDiscussion.map((i) => i.sourceType));
    expect(types.has("news")).toBe(true);
    expect(types.has("hackernews")).toBe(true);
    expect(types.has("github")).toBe(false);
    expect(types.has("paper")).toBe(false);
  });
});

describe("summarizeSourceFreshness", () => {
  const configuredKeys = ["hackernews", "arxiv", "github", "rss:openai"];

  it("reports a completely never-refreshed corpus", () => {
    const summary = summarizeSourceFreshness([], NOW, configuredKeys);
    expect(summary.overallLastRefreshedAt).toBeNull();
    expect(summary.isStale).toBe(true);
    expect(summary.neverRefreshedSourceLabels).toHaveLength(configuredKeys.length);
    expect(summary.failedSourceLabels).toHaveLength(0);
  });

  it("identifies one source that has never refreshed while others have", () => {
    const health = [
      makeHealth({ sourceKey: "hackernews", lastStatus: "success", lastSucceededAt: hoursAgoDate(1) }),
      makeHealth({ sourceKey: "arxiv", lastStatus: "success", lastSucceededAt: hoursAgoDate(2) }),
      makeHealth({ sourceKey: "github", lastStatus: "success", lastSucceededAt: hoursAgoDate(3) }),
      // "rss:openai" has no row at all — never attempted.
    ];
    const summary = summarizeSourceFreshness(health, NOW, configuredKeys);
    expect(summary.neverRefreshedSourceLabels).toEqual(["rss:openai"]);
    expect(summary.overallLastRefreshedAt).toEqual(hoursAgoDate(1));
  });

  it("reports failed sources without losing the last known success", () => {
    const health = [
      makeHealth({ sourceKey: "hackernews", lastStatus: "success", lastSucceededAt: hoursAgoDate(1) }),
      makeHealth({ sourceKey: "arxiv", lastStatus: "failed", lastSucceededAt: hoursAgoDate(30), sourceLabel: "arXiv" }),
      makeHealth({ sourceKey: "github", lastStatus: "success", lastSucceededAt: hoursAgoDate(2) }),
      makeHealth({ sourceKey: "rss:openai", lastStatus: "success", lastSucceededAt: hoursAgoDate(4) }),
    ];
    const summary = summarizeSourceFreshness(health, NOW, configuredKeys);
    expect(summary.failedSourceLabels).toEqual(["arXiv"]);
    // The overall "last refreshed" reflects the most recent SUCCESS across
    // all sources, unaffected by one source's failure.
    expect(summary.overallLastRefreshedAt).toEqual(hoursAgoDate(1));
    expect(summary.neverRefreshedSourceLabels).toHaveLength(0);
  });

  it("is not stale just inside the threshold, and stale just past it", () => {
    const freshHealth = configuredKeys.map((key) =>
      makeHealth({ sourceKey: key, lastStatus: "success", lastSucceededAt: new Date(NOW.getTime() - BRIEFING_STALE_THRESHOLD_MS + 1000) })
    );
    expect(summarizeSourceFreshness(freshHealth, NOW, configuredKeys).isStale).toBe(false);

    const staleHealth = configuredKeys.map((key) =>
      makeHealth({ sourceKey: key, lastStatus: "success", lastSucceededAt: new Date(NOW.getTime() - BRIEFING_STALE_THRESHOLD_MS - 1000) })
    );
    expect(summarizeSourceFreshness(staleHealth, NOW, configuredKeys).isStale).toBe(true);
  });

  function hoursAgoDate(hours: number): Date {
    return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  }
});

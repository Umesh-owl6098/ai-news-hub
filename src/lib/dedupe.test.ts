import { describe, expect, it } from "vitest";
import { dedupeFeedItems } from "@/lib/dedupe";
import { canonicalizeUrl } from "@/lib/url";
import { normalizeTitle } from "@/lib/title";
import type { FeedItem, SourceType } from "@/types/feed";

function makeItem(id: string, sourceType: SourceType, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    sourceType,
    sourceName: sourceType,
    title: `Title ${id}`,
    description: "desc",
    publishedAt: "2026-09-01T00:00:00.000Z",
    tags: [],
    score: 0,
    commentCount: 0,
    url: `https://example.com/${id}`,
    ...overrides,
  };
}

const ids = (items: FeedItem[]) => items.map((i) => i.id);

describe("dedupeFeedItems — order preservation", () => {
  it("returns non-duplicates in exactly the order supplied, regardless of source type", () => {
    // Deliberately the reverse of source priority (news < paper/github < hackernews < discussion).
    const input = [
      makeItem("d", "discussion"),
      makeItem("h", "hackernews"),
      makeItem("g", "github"),
      makeItem("p", "paper"),
      makeItem("n", "news"),
    ];
    expect(ids(dedupeFeedItems(input))).toEqual(["d", "h", "g", "p", "n"]);
  });

  it("preserves a caller's newest-first ordering across mixed source types", () => {
    const input = [
      makeItem("gh-newest", "github", { publishedAt: "2026-09-23T05:00:00.000Z" }),
      makeItem("news-mid", "news", { publishedAt: "2026-09-22T05:00:00.000Z" }),
      makeItem("hn-old", "hackernews", { publishedAt: "2026-09-21T05:00:00.000Z" }),
      makeItem("paper-oldest", "paper", { publishedAt: "2026-09-20T05:00:00.000Z" }),
    ];
    const out = dedupeFeedItems(input);
    const times = out.map((i) => new Date(i.publishedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(ids(out)).toEqual(ids(input));
  });

  it("removing a duplicate does not globally reorder the unrelated items around it", () => {
    const input = [
      makeItem("a-hn", "hackernews", { url: "https://example.com/shared", title: "Shared Story" }),
      makeItem("b-paper", "paper"),
      makeItem("c-news", "news", { url: "https://example.com/shared", title: "Shared Story (publisher)" }),
      makeItem("d-github", "github"),
      makeItem("e-hn", "hackernews"),
    ];
    // The news copy wins the duplicate, but survivors keep their input positions —
    // the winner is NOT hoisted to the front, and unrelated items don't move.
    expect(ids(dedupeFeedItems(input))).toEqual(["b-paper", "c-news", "d-github", "e-hn"]);
  });

  it("does not mutate the input array", () => {
    const input = [makeItem("x", "hackernews"), makeItem("y", "news")];
    const snapshot = ids(input);
    dedupeFeedItems(input);
    expect(ids(input)).toEqual(snapshot);
  });

  it("handles empty and single-item input", () => {
    expect(dedupeFeedItems([])).toEqual([]);
    const only = makeItem("only", "news");
    expect(dedupeFeedItems([only])).toEqual([only]);
  });
});

describe("dedupeFeedItems — duplicate selection", () => {
  it("keeps the higher-priority source (news over hackernews) for the same canonical URL, wherever it appears", () => {
    const hnFirst = [
      makeItem("hn", "hackernews", { url: "https://example.com/story?utm_source=x" }),
      makeItem("news", "news", { url: "https://example.com/story" }),
    ];
    const newsFirst = [...hnFirst].reverse();
    expect(ids(dedupeFeedItems(hnFirst))).toEqual(["news"]);
    expect(ids(dedupeFeedItems(newsFirst))).toEqual(["news"]);
  });

  it("also dedupes on normalized title when URLs differ", () => {
    const input = [
      makeItem("hn", "hackernews", { title: "Same Headline!", url: "https://a.example/1" }),
      makeItem("news", "news", { title: "same headline", url: "https://b.example/2" }),
    ];
    expect(ids(dedupeFeedItems(input))).toEqual(["news"]);
  });

  it("breaks a same-priority tie deterministically: the earlier item in the input wins", () => {
    const input = [
      makeItem("first-paper", "paper", { url: "https://example.com/dup" }),
      makeItem("second-github", "github", { url: "https://example.com/dup" }),
    ];
    expect(ids(dedupeFeedItems(input))).toEqual(["first-paper"]);
    expect(ids(dedupeFeedItems([...input].reverse()))).toEqual(["second-github"]);
  });

  it("gives the same result on repeated calls with the same input", () => {
    const input = [
      makeItem("hn", "hackernews", { url: "https://example.com/s" }),
      makeItem("n1", "news", { url: "https://example.com/s" }),
      makeItem("n2", "news", { url: "https://example.com/other" }),
    ];
    const runs = Array.from({ length: 5 }, () => ids(dedupeFeedItems(input)).join(","));
    expect(new Set(runs).size).toBe(1);
  });
});

/**
 * The survivors must be exactly the same items the previous implementation
 * kept — only their ORDER changed (it now follows the caller's order). This
 * reference copy is the previous algorithm verbatim, compared over a
 * deterministic pseudo-random set with many URL/title collisions.
 */
describe("dedupeFeedItems — same survivors as the previous implementation", () => {
  const PRIORITY: Record<SourceType, number> = { news: 0, paper: 1, github: 1, hackernews: 2, discussion: 3 };

  function legacySurvivors(items: FeedItem[]): Set<string> {
    const sorted = [...items].sort((a, b) => PRIORITY[a.sourceType] - PRIORITY[b.sourceType]);
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    const kept = new Set<string>();
    for (const item of sorted) {
      const urlKey = canonicalizeUrl(item.url);
      const titleKey = normalizeTitle(item.title);
      if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) continue;
      seenUrls.add(urlKey);
      seenTitles.add(titleKey);
      kept.add(item.id);
    }
    return kept;
  }

  function seededItems(seed: number, count: number): FeedItem[] {
    let state = seed;
    const next = (n: number) => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state % n;
    };
    const types: SourceType[] = ["news", "paper", "github", "hackernews", "discussion"];
    return Array.from({ length: count }, (_, i) =>
      makeItem(`i${i}`, types[next(types.length)], {
        url: `https://example.com/u${next(12)}`,
        title: `Headline ${next(12)}`,
      })
    );
  }

  it.each([1, 7, 42, 2026, 99991])("keeps the identical set of items for seed %i", (seed) => {
    const input = seededItems(seed, 60);
    const survivors = new Set(ids(dedupeFeedItems(input)));
    expect(survivors).toEqual(legacySurvivors(input));
    // ...and they appear in input order.
    const inputOrder = ids(input).filter((id) => survivors.has(id));
    expect(ids(dedupeFeedItems(input))).toEqual(inputOrder);
  });
});

import { describe, expect, it } from "vitest";
import {
  parseSearchState,
  buildSearchQueryString,
  applySearchStateUpdate,
  isSearchActive,
  getAvailableSorts,
  getFixedSortLabel,
  normalizeSort,
  MAX_QUERY_LENGTH,
  type SearchState,
} from "./searchState";

describe("parseSearchState", () => {
  it("defaults to All/any-time/latest/page-1 with no params", () => {
    const state = parseSearchState({});
    expect(state).toEqual({ tab: "All", q: "", time: "any", source: undefined, sort: "latest", page: 1, mode: "keyword" });
  });

  it("maps a known tab slug", () => {
    expect(parseSearchState({ tab: "github" }).tab).toBe("GitHub");
    expect(parseSearchState({ tab: "hn" }).tab).toBe("Hacker News");
    expect(parseSearchState({ tab: "bookmarks" }).tab).toBe("Bookmarks");
  });

  it("falls back to All for an unknown tab slug rather than erroring", () => {
    expect(parseSearchState({ tab: "not-a-real-tab" }).tab).toBe("All");
    expect(parseSearchState({ tab: "'; drop table feed_items; --" }).tab).toBe("All");
  });

  it("truncates an excessively long query rather than rejecting the request", () => {
    const huge = "a".repeat(MAX_QUERY_LENGTH + 500);
    const state = parseSearchState({ q: huge });
    expect(state.q.length).toBe(MAX_QUERY_LENGTH);
  });

  it("trims whitespace from the query", () => {
    expect(parseSearchState({ q: "  agents  " }).q).toBe("agents");
  });

  it("falls back to 'any' for an invalid time range", () => {
    expect(parseSearchState({ time: "3000d" }).time).toBe("any");
    expect(parseSearchState({ time: "7d" }).time).toBe("7d");
  });

  it("rejects a source value with disallowed characters rather than passing it through", () => {
    expect(parseSearchState({ source: "openai" }).source).toBe("openai");
    expect(parseSearchState({ source: "openai; DROP TABLE feed_items;" }).source).toBeUndefined();
    expect(parseSearchState({ source: "'; --" }).source).toBeUndefined();
  });

  it("defaults sort to relevance when searching, latest when not", () => {
    expect(parseSearchState({ q: "agents" }).sort).toBe("relevance");
    expect(parseSearchState({}).sort).toBe("latest");
  });

  it("rejects a sort value that doesn't belong to the current mode", () => {
    // "top" is a browse-mode sort; irrelevant/invalid once a query is present.
    expect(parseSearchState({ q: "agents", sort: "top" }).sort).toBe("relevance");
    // "relevance" is a search-mode sort; invalid with no query active.
    expect(parseSearchState({ sort: "relevance" }).sort).toBe("latest");
  });

  it("clamps page to a safe positive integer", () => {
    expect(parseSearchState({ page: "3" }).page).toBe(3);
    expect(parseSearchState({ page: "0" }).page).toBe(1);
    expect(parseSearchState({ page: "-5" }).page).toBe(1);
    expect(parseSearchState({ page: "not-a-number" }).page).toBe(1);
    expect(parseSearchState({ page: "999999" }).page).toBe(1);
  });

  it("handles an array-valued param (duplicate query key) by taking the first value", () => {
    expect(parseSearchState({ q: ["agents", "ignored"] }).q).toBe("agents");
  });

  it("defaults mode to keyword and accepts a valid semantic value", () => {
    expect(parseSearchState({}).mode).toBe("keyword");
    expect(parseSearchState({ mode: "semantic" }).mode).toBe("semantic");
  });

  it("falls back to keyword for an invalid mode value rather than erroring", () => {
    expect(parseSearchState({ mode: "hybrid" }).mode).toBe("keyword");
    expect(parseSearchState({ mode: "'; drop table feed_items; --" }).mode).toBe("keyword");
  });
});

describe("isSearchActive", () => {
  it("is false for a bare tab with no filters", () => {
    expect(
      isSearchActive({ tab: "GitHub", q: "", time: "any", source: undefined, sort: "latest", page: 1, mode: "keyword" })
    ).toBe(false);
  });

  it("is true when a query, time filter, source filter, or page>1 is present", () => {
    const base = {
      tab: "All" as const,
      q: "",
      time: "any" as const,
      source: undefined,
      sort: "relevance" as const,
      page: 1,
      mode: "keyword" as const,
    };
    expect(isSearchActive({ ...base, q: "agents" })).toBe(true);
    expect(isSearchActive({ ...base, time: "7d" })).toBe(true);
    expect(isSearchActive({ ...base, source: "openai" })).toBe(true);
    expect(isSearchActive({ ...base, page: 2 })).toBe(true);
  });
});

describe("applySearchStateUpdate", () => {
  it("resets sort to relevance when a query turns on search mode (regression: stale 'latest' from browse mode)", () => {
    const browsing = parseSearchState({}); // sort: "latest"
    const next = applySearchStateUpdate(browsing, { q: "agents" });
    expect(next.sort).toBe("relevance");
  });

  it("resets sort to latest when clearing the query turns search mode back off", () => {
    const searching = parseSearchState({ q: "agents", sort: "newest" });
    const next = applySearchStateUpdate(searching, { q: "" });
    expect(next.sort).toBe("latest");
  });

  it("preserves an explicit sort choice made in the same update", () => {
    const browsing = parseSearchState({});
    const next = applySearchStateUpdate(browsing, { q: "agents", sort: "newest" });
    expect(next.sort).toBe("newest");
  });

  it("resets page to 1 on every update unless page is explicitly part of it", () => {
    const withPage = parseSearchState({ q: "agents", page: "3" });
    expect(applySearchStateUpdate(withPage, { time: "7d" }).page).toBe(1);
    expect(applySearchStateUpdate(withPage, { page: 2 }).page).toBe(2);
  });
});

describe("buildSearchQueryString", () => {
  it("omits default values entirely, producing a clean URL", () => {
    expect(
      buildSearchQueryString({ tab: "All", q: "", time: "any", source: undefined, sort: "latest", page: 1, mode: "keyword" })
    ).toBe("");
  });

  it("round-trips through parseSearchState", () => {
    const original = parseSearchState({ tab: "news", q: "agents", time: "7d", source: "openai", page: "2" });
    const qs = buildSearchQueryString(original);
    const params = Object.fromEntries(new URLSearchParams(qs));
    const roundTripped = parseSearchState(params);
    expect(roundTripped).toEqual(original);
  });

  it("includes mode in the URL only when it isn't the default, and round-trips it", () => {
    const keyword = parseSearchState({ q: "agents" });
    expect(buildSearchQueryString(keyword)).not.toContain("mode=");

    const semantic = parseSearchState({ q: "agents", mode: "semantic" });
    const qs = buildSearchQueryString(semantic);
    expect(qs).toContain("mode=semantic");
    const roundTripped = parseSearchState(Object.fromEntries(new URLSearchParams(qs)));
    expect(roundTripped).toEqual(semantic);
  });
});

describe("getAvailableSorts — which orderings are real for a view", () => {
  it("Hacker News browse supports Latest, Top and Most Discussed (the only source with real engagement metrics)", () => {
    expect(getAvailableSorts("Hacker News", false, "keyword")).toEqual(["latest", "top", "discussed"]);
  });

  it.each(["Papers", "GitHub", "News", "Discussions", "Bookmarks", "All"] as const)(
    "%s browse offers Latest only — no engagement sorts that would just repeat Latest or compare unlike sources",
    (tab) => {
      expect(getAvailableSorts(tab, false, "keyword")).toEqual(["latest"]);
    }
  );

  it.each(["All", "Papers", "Hacker News", "GitHub", "News"] as const)(
    "Keyword search on %s supports Relevance and Newest",
    (tab) => {
      expect(getAvailableSorts(tab, true, "keyword")).toEqual(["relevance", "newest"]);
    }
  );

  it.each(["All", "Papers", "Hacker News"] as const)(
    "Semantic search on %s exposes only its similarity ranking — no Newest that would change nothing",
    (tab) => {
      const sorts = getAvailableSorts(tab, true, "semantic");
      expect(sorts).toEqual(["relevance"]);
      expect(sorts).not.toContain("newest");
    }
  );

  it("never mixes browse and search sorts", () => {
    for (const tab of ["All", "Papers", "Hacker News"] as const) {
      expect(getAvailableSorts(tab, true, "keyword")).not.toContain("top");
      expect(getAvailableSorts(tab, false, "keyword")).not.toContain("newest");
    }
  });
});

describe("normalizeSort", () => {
  it("keeps a supported sort", () => {
    expect(normalizeSort("top", "Hacker News", false, "keyword")).toBe("top");
    expect(normalizeSort("newest", "All", true, "keyword")).toBe("newest");
  });

  it("falls back to the view's default for an unsupported sort", () => {
    expect(normalizeSort("top", "Papers", false, "keyword")).toBe("latest");
    expect(normalizeSort("newest", "All", true, "semantic")).toBe("relevance");
    expect(normalizeSort("nonsense", "Hacker News", false, "keyword")).toBe("latest");
    expect(normalizeSort("nonsense", "All", true, "keyword")).toBe("relevance");
  });

  it("is deterministic — the same input always yields the same output", () => {
    const results = new Set(Array.from({ length: 5 }, () => normalizeSort("discussed", "GitHub", false, "keyword")));
    expect([...results]).toEqual(["latest"]);
  });
});

describe("parseSearchState — unsupported sort/tab/mode combinations from a URL", () => {
  it("Papers falls back from Top and Most Discussed to Latest", () => {
    expect(parseSearchState({ tab: "papers", sort: "top" }).sort).toBe("latest");
    expect(parseSearchState({ tab: "papers", sort: "discussed" }).sort).toBe("latest");
  });

  it("News falls back from Top and Most Discussed to Latest", () => {
    expect(parseSearchState({ tab: "news", sort: "top" }).sort).toBe("latest");
    expect(parseSearchState({ tab: "news", sort: "discussed" }).sort).toBe("latest");
  });

  it("GitHub falls back from Top and Most Discussed to Latest", () => {
    expect(parseSearchState({ tab: "github", sort: "top" }).sort).toBe("latest");
    expect(parseSearchState({ tab: "github", sort: "discussed" }).sort).toBe("latest");
  });

  it("Discussions and Bookmarks fall back to Latest", () => {
    expect(parseSearchState({ tab: "discussions", sort: "top" }).sort).toBe("latest");
    expect(parseSearchState({ tab: "bookmarks", sort: "discussed" }).sort).toBe("latest");
  });

  it("Hacker News keeps Latest, Top and Most Discussed", () => {
    expect(parseSearchState({ tab: "hn", sort: "latest" }).sort).toBe("latest");
    expect(parseSearchState({ tab: "hn", sort: "top" }).sort).toBe("top");
    expect(parseSearchState({ tab: "hn", sort: "discussed" }).sort).toBe("discussed");
  });

  it("All does not honor Top or Most Discussed (misleading across heterogeneous sources)", () => {
    expect(parseSearchState({ sort: "top" }).sort).toBe("latest");
    expect(parseSearchState({ tab: "all", sort: "discussed" }).sort).toBe("latest");
  });

  it("Keyword search keeps Relevance and Newest, on any tab", () => {
    expect(parseSearchState({ q: "agents", sort: "relevance" }).sort).toBe("relevance");
    expect(parseSearchState({ q: "agents", sort: "newest" }).sort).toBe("newest");
    expect(parseSearchState({ tab: "papers", q: "agents", sort: "newest" }).sort).toBe("newest");
  });

  it("Semantic search does not keep a Newest sort it can't honor", () => {
    expect(parseSearchState({ q: "agents", mode: "semantic", sort: "newest" }).sort).toBe("relevance");
  });

  it("an unrecognized sort value normalizes to the view's default, deterministically", () => {
    expect(parseSearchState({ tab: "hn", sort: "bogus" }).sort).toBe("latest");
    expect(parseSearchState({ q: "agents", sort: "bogus" }).sort).toBe("relevance");
    expect(parseSearchState({ tab: "hn", sort: ["top", "x"] }).sort).toBe("top");
    expect(parseSearchState({ tab: "papers", sort: ["top", "x"] }).sort).toBe("latest");
  });

  it("treats page > 1 as search mode for sort purposes, consistent with isSearchActive", () => {
    const state = parseSearchState({ page: "2", sort: "newest" });
    expect(isSearchActive(state)).toBe(true);
    expect(state.sort).toBe("newest");
  });
});

describe("applySearchStateUpdate — navigation never leaves an unsupported sort behind", () => {
  it("switching from Hacker News (Top) to Papers resets to Latest", () => {
    const hn = parseSearchState({ tab: "hn", sort: "top" });
    expect(applySearchStateUpdate(hn, { tab: "Papers" }).sort).toBe("latest");
  });

  it("switching between tabs that both support the sort keeps it", () => {
    const hn = parseSearchState({ tab: "hn", sort: "top" });
    expect(applySearchStateUpdate(hn, { sort: "discussed" }).sort).toBe("discussed");
  });

  it("switching a Newest keyword search to Semantic resets to the similarity ranking", () => {
    const keyword = parseSearchState({ q: "agents", sort: "newest" });
    expect(applySearchStateUpdate(keyword, { mode: "semantic" }).sort).toBe("relevance");
  });

  it("switching back from Semantic to Keyword keeps a valid Relevance sort", () => {
    const semantic = parseSearchState({ q: "agents", mode: "semantic" });
    expect(applySearchStateUpdate(semantic, { mode: "keyword" }).sort).toBe("relevance");
  });
});

describe("buildSearchQueryString — shareable URLs for supported sorts only", () => {
  const base: SearchState = { tab: "Hacker News", q: "", time: "any", source: undefined, sort: "top", page: 1, mode: "keyword" };

  it("emits a supported non-default sort and round-trips it", () => {
    const qs = buildSearchQueryString(base);
    expect(qs).toBe("?tab=hn&sort=top");
    expect(parseSearchState(Object.fromEntries(new URLSearchParams(qs)))).toEqual(base);
  });

  it("never needs a sort param for tabs that only support Latest", () => {
    const papers = parseSearchState({ tab: "papers", sort: "top" });
    expect(buildSearchQueryString(papers)).toBe("?tab=papers");
  });
});

describe("getFixedSortLabel — what a no-choice ranking is called", () => {
  it("labels a Semantic search that ran as Semantic 'Similarity'", () => {
    expect(getFixedSortLabel(true, "semantic", "semantic")).toBe("Similarity");
  });

  it("labels a Semantic request that fell back to Keyword 'Relevance' (never claims similarity ranking)", () => {
    expect(getFixedSortLabel(true, "semantic", "keyword")).toBe("Relevance");
  });

  it("has no override for Keyword search or plain browsing (label comes from the single sort option)", () => {
    expect(getFixedSortLabel(true, "keyword", "keyword")).toBeUndefined();
    expect(getFixedSortLabel(false, "keyword", "keyword")).toBeUndefined();
    expect(getFixedSortLabel(false, "semantic", "semantic")).toBeUndefined();
  });
});

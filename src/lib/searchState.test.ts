import { describe, expect, it } from "vitest";
import {
  parseSearchState,
  buildSearchQueryString,
  applySearchStateUpdate,
  isSearchActive,
  MAX_QUERY_LENGTH,
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

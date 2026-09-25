import type { FilterValue } from "@/components/FeedFilters";
import type { SourceType } from "@/types/feed";

/**
 * Single source of truth for URL <-> search-state parsing. Every value that
 * originates from a URL query parameter is untrusted user input — this
 * module is the one place that validates, bounds, and normalizes it before
 * it ever reaches a database query or a React prop. Invalid values are
 * silently coerced to a safe default rather than surfaced as an error or
 * (worse) passed through to SQL.
 */

// A tab IS the source-type/bookmarked-only filter (see DashboardClient) —
// deliberately one selector, not two competing ones.
const TAB_TO_SLUG: Record<FilterValue, string> = {
  All: "all",
  News: "news",
  Papers: "papers",
  GitHub: "github",
  "Hacker News": "hn",
  Discussions: "discussions",
  Bookmarks: "bookmarks",
};

const SLUG_TO_TAB: Record<string, FilterValue> = Object.fromEntries(
  Object.entries(TAB_TO_SLUG).map(([tab, slug]) => [slug, tab as FilterValue])
);

export function tabSlug(tab: FilterValue): string {
  return TAB_TO_SLUG[tab];
}

const TAB_TO_SOURCE_TYPE: Partial<Record<FilterValue, SourceType>> = {
  News: "news",
  Papers: "paper",
  GitHub: "github",
  "Hacker News": "hackernews",
  Discussions: "discussion",
};

export function tabToSourceType(tab: FilterValue): SourceType | undefined {
  return TAB_TO_SOURCE_TYPE[tab];
}

export const TIME_RANGES = ["any", "24h", "7d", "30d"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

const TIME_RANGE_TO_DAYS: Record<Exclude<TimeRange, "any">, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
};

export function timeRangeToDays(range: TimeRange): number | undefined {
  return range === "any" ? undefined : TIME_RANGE_TO_DAYS[range];
}

export const SEARCH_SORTS = ["relevance", "newest"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const BROWSE_SORTS = ["latest", "top", "discussed"] as const;
export type BrowseSort = (typeof BROWSE_SORTS)[number];

export type AnySort = SearchSort | BrowseSort;

/**
 * The one place that decides which sorts are real for a given view, so a
 * sort control can never offer (and a URL can never select) an ordering
 * that wouldn't actually change the results.
 *
 * Browse mode: only Hacker News carries real engagement metrics (score,
 * comment count) — arXiv/GitHub/RSS items are ingested with both at 0
 * (GitHub's meaningful metrics are stars/forks, deliberately not used
 * here), Discussions is a single hard-coded mock, and All/Bookmarks mix
 * sources where most items have no metrics, so "Top"/"Most Discussed"
 * would be a misleading comparison. Everything else is Latest only.
 *
 * Search mode: Keyword supports Relevance/Newest (SQL ORDER BY). Semantic
 * results are ranked by vector similarity and `semanticSearch` takes no
 * sort at all, so the only honest choice is the single ranking it has.
 */
export function getAvailableSorts(tab: FilterValue, searching: boolean, mode: SearchMode): readonly AnySort[] {
  if (searching) return mode === "semantic" ? ["relevance"] : SEARCH_SORTS;
  return tab === "Hacker News" ? BROWSE_SORTS : ["latest"];
}

export function defaultSortFor(searching: boolean): AnySort {
  return searching ? "relevance" : "latest";
}

/**
 * Label for a view whose ranking is fixed (no selector). A requested-
 * Semantic search that actually ran as Semantic is ranked by vector
 * similarity; if it fell back to Keyword, it's Keyword relevance. Returns
 * undefined when the label should just come from the single sort option.
 */
export function getFixedSortLabel(searching: boolean, requestedMode: SearchMode, effectiveMode: SearchMode): string | undefined {
  if (!searching || requestedMode !== "semantic") return undefined;
  return effectiveMode === "semantic" ? "Similarity" : "Relevance";
}

/** Returns `sort` if it's valid for this view, otherwise the view's default. */
export function normalizeSort(sort: string, tab: FilterValue, searching: boolean, mode: SearchMode): AnySort {
  const available = getAvailableSorts(tab, searching, mode);
  return (available as readonly string[]).includes(sort) ? (sort as AnySort) : defaultSortFor(searching);
}

// Comfortably fits any real query while rejecting pathological input —
// documented per Step 8 §28 rather than left as an arbitrary number.
export const MAX_QUERY_LENGTH = 300;

export const SEARCH_PAGE_SIZE = 24;
const MAX_PAGE = 500; // sanity bound — not a real pagination limit, just an abuse guard

// Step 18: user-chosen retrieval strategy. "keyword" (existing FTS) stays
// the default; "semantic" is opt-in. Hybrid is deliberately not a member of
// this type — it remains internal/evaluation-only (see semanticSearch.ts).
export const SEARCH_MODES = ["keyword", "semantic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface SearchState {
  tab: FilterValue;
  q: string;
  time: TimeRange;
  /** Publisher sourceId (e.g. "openai") — only meaningful for the News tab. */
  source: string | undefined;
  sort: SearchSort | BrowseSort;
  page: number;
  mode: SearchMode;
}

/** A search-relevant filter is active — i.e. something beyond "just browse
 * this tab" — which is when results come from the database search
 * repository instead of the existing live-fetch tabs. */
export function isSearchActive(state: SearchState): boolean {
  return state.q.length > 0 || state.time !== "any" || Boolean(state.source) || state.page > 1;
}

type RawParams = Record<string, string | string[] | undefined>;

function firstString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

const SOURCE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function parseSearchState(params: RawParams): SearchState {
  const rawTab = (firstString(params.tab) ?? "").toLowerCase();
  const tab = SLUG_TO_TAB[rawTab] ?? "All";

  const rawQ = firstString(params.q) ?? "";
  const q = rawQ.slice(0, MAX_QUERY_LENGTH).trim();

  const rawTime = firstString(params.time) ?? "any";
  const time = (TIME_RANGES as readonly string[]).includes(rawTime) ? (rawTime as TimeRange) : "any";

  const rawSource = firstString(params.source);
  const source = rawSource && SOURCE_ID_PATTERN.test(rawSource) ? rawSource : undefined;

  const rawPage = Number.parseInt(firstString(params.page) ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 && rawPage <= MAX_PAGE ? rawPage : 1;

  const rawMode = firstString(params.mode) ?? "keyword";
  const mode = (SEARCH_MODES as readonly string[]).includes(rawMode) ? (rawMode as SearchMode) : "keyword";

  // `page` counts toward "searching" (see isSearchActive), and the valid
  // sorts depend on tab and mode too — so sort is resolved last, from the
  // already-validated values above.
  const searching = q.length > 0 || time !== "any" || Boolean(source) || page > 1;
  const sort = normalizeSort(firstString(params.sort) ?? "", tab, searching, mode);

  return { tab, q, time, source, sort, page, mode };
}

/**
 * Merges a partial update into the current state for navigation, then
 * reconciles `sort`: if the browse<->search mode changed as a result (e.g.
 * typing a query while sort was "latest" from browse mode), `sort` is reset
 * to the new mode's default rather than carrying over a value that no
 * longer belongs to a valid option set. Explicit sort changes in the same
 * update are preserved.
 */
export function applySearchStateUpdate(current: SearchState, partial: Partial<SearchState>): SearchState {
  const merged: SearchState = { ...current, page: 1, ...partial };
  const sort = normalizeSort(merged.sort, merged.tab, isSearchActive(merged), merged.mode);
  return sort === merged.sort ? merged : { ...merged, sort };
}

/**
 * Builds the query string for a URL reflecting `state`, omitting anything
 * at its default value so URLs stay clean (e.g. `/` not `/?tab=all&time=any&page=1`).
 */
export function buildSearchQueryString(state: SearchState): string {
  const params = new URLSearchParams();
  if (state.tab !== "All") params.set("tab", tabSlug(state.tab));
  if (state.q) params.set("q", state.q);
  if (state.time !== "any") params.set("time", state.time);
  if (state.source) params.set("source", state.source);

  const searching = isSearchActive(state);
  if (state.sort !== defaultSortFor(searching)) params.set("sort", state.sort);

  if (state.page > 1) params.set("page", String(state.page));
  if (state.mode !== "keyword") params.set("mode", state.mode);

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

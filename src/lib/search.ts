import "server-only";
import { isDatabaseConfigured } from "@/db";
import { searchFeedItems, DatabaseError } from "@/db/repository";
import { semanticSearch } from "@/lib/ai/semanticSearch";
import { getEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import { tabToSourceType, timeRangeToDays, SEARCH_PAGE_SIZE, type SearchState, type SearchMode } from "@/lib/searchState";
import { FeedItem } from "@/types/feed";

export interface SearchResult {
  items: FeedItem[];
  total: number;
  /** Non-null means search genuinely could not run (no DB, or DB error) —
   * distinct from "ran fine, zero matches." */
  error: string | null;
  /** What the caller asked for (from URL state) vs. what actually ran.
   * They differ exactly when a Semantic request fell back to Keyword —
   * UI must render `effectiveMode`, never silently present `items` as if
   * they came from `requestedMode` (Step 18 §3). */
  requestedMode: SearchMode;
  effectiveMode: SearchMode;
}

function keywordFilters(state: SearchState) {
  return {
    sourceType: state.tab === "Bookmarks" ? undefined : tabToSourceType(state.tab),
    sourceId: state.source,
    sinceDays: timeRangeToDays(state.time),
    bookmarkedOnly: state.tab === "Bookmarks",
  };
}

async function runKeywordSearch(state: SearchState): Promise<{ items: FeedItem[]; total: number; error: string | null }> {
  try {
    const result = await searchFeedItems({
      ...keywordFilters(state),
      query: state.q,
      sort: state.sort === "relevance" || state.sort === "newest" ? state.sort : undefined,
      limit: SEARCH_PAGE_SIZE,
      offset: (state.page - 1) * SEARCH_PAGE_SIZE,
    });
    return { items: result.items, total: result.total, error: null };
  } catch (error) {
    const message = error instanceof DatabaseError ? error.message : "Stored search is temporarily unavailable.";
    return { items: [], total: 0, error: message };
  }
}

/**
 * Runs a database search for the given URL-derived state. Never throws —
 * callers get a clear, safe error string instead, and must not pretend
 * search worked when it didn't (Step 8 §16: don't silently fall back to a
 * different implementation, and don't show a live-feed fallback for search
 * the way Step 6 does for the ordinary tabs — persisted search either works
 * or clearly says it doesn't).
 *
 * Step 18: `state.mode === "semantic"` additionally requires a configured
 * embedding provider. If it's absent, or the provider/query-embedding call
 * fails transiently, this falls back to the exact same keyword path for
 * that one request — `effectiveMode` in the returned result says which
 * actually ran, so the UI never presents fallback results as semantic ones.
 * Semantic results are a single bounded top-K page (see semanticSearch) —
 * there is no offset pagination for Semantic mode; `page` is ignored for it
 * by design (documented tradeoff, see Step 18 final report §6).
 */
export async function performSearch(state: SearchState): Promise<SearchResult> {
  if (!isDatabaseConfigured()) {
    return {
      items: [],
      total: 0,
      error: "Persistent search isn't available without a configured database.",
      requestedMode: state.mode,
      effectiveMode: state.mode,
    };
  }

  if (state.mode !== "semantic") {
    const result = await runKeywordSearch(state);
    return { ...result, requestedMode: "keyword", effectiveMode: "keyword" };
  }

  if (!getEmbeddingProvider()) {
    const result = await runKeywordSearch(state);
    return { ...result, requestedMode: "semantic", effectiveMode: "keyword" };
  }

  try {
    const results = await semanticSearch(state.q, keywordFilters(state), SEARCH_PAGE_SIZE);
    return { items: results.map((r) => r.item), total: results.length, error: null, requestedMode: "semantic", effectiveMode: "semantic" };
  } catch (error) {
    // Transient failure — a configured provider that errored on this
    // specific query embedding call (network, rate limit, auth). Retry as
    // Keyword for this request rather than surfacing a raw provider error.
    // Logged server-side only (never sent to the browser) so an operator
    // can tell a real outage apart from "no provider configured."
    console.error("[ai:search] semantic search failed, falling back to keyword:", error);
    const result = await runKeywordSearch(state);
    return { ...result, requestedMode: "semantic", effectiveMode: "keyword" };
  }
}

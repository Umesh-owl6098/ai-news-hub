"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { TIME_RANGES, SEARCH_PAGE_SIZE, SEARCH_MODES, type TimeRange, type SearchState, type SearchMode } from "@/lib/searchState";

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  any: "Any time",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const MODE_LABELS: Record<SearchMode, string> = {
  keyword: "Keyword",
  semantic: "Semantic",
};

interface SearchControlsProps {
  state: SearchState;
  total: number;
  /** Whether an embedding provider is configured at all — determines
   * whether Semantic can be picked before a search even runs (Step 18 §3). */
  semanticAvailable: boolean;
  /** What actually ran for the current results — used only to keep
   * pagination honest (Semantic is a single bounded page, see lib/search.ts),
   * never to override what the user selected in `state.mode`. */
  effectiveMode: SearchMode;
  onTimeChange: (time: TimeRange) => void;
  onModeChange: (mode: SearchMode) => void;
  onClearFilters: () => void;
  onClearSearch: () => void;
  onPageChange: (page: number) => void;
}

export function SearchControls({
  state,
  total,
  semanticAvailable,
  effectiveMode,
  onTimeChange,
  onModeChange,
  onClearFilters,
  onClearSearch,
  onPageChange,
}: SearchControlsProps) {
  const hasFilters = state.time !== "any" || Boolean(state.source);
  // Semantic returns one bounded top-K page, not an offset-paginated set
  // (semanticSearch has no `offset`) — so pagination only ever applies once
  // a Keyword request has actually run.
  const totalPages = effectiveMode === "keyword" ? Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span>
          {total === 0 ? "No results" : `${total} result${total === 1 ? "" : "s"}`}
          {state.q && (
            <>
              {" "}for &ldquo;{state.q}&rdquo;
            </>
          )}
        </span>

        {state.q && (
          <button
            type="button"
            onClick={onClearSearch}
            className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <X size={12} />
            Clear search
          </button>
        )}

        {hasFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <X size={12} />
            Clear filters
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Search mode"
          className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm"
        >
          {SEARCH_MODES.map((mode) => {
            const disabled = mode === "semantic" && !semanticAvailable;
            const active = state.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                title={disabled ? "Semantic search isn't configured for this deployment." : undefined}
                onClick={() => onModeChange(mode)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                  active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                } ${disabled ? "cursor-not-allowed opacity-40 hover:text-slate-500" : ""}`}
              >
                {MODE_LABELS[mode]}
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <span className="sr-only">Time range</span>
          <select
            value={state.time}
            onChange={(e) => onTimeChange(e.target.value as TimeRange)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          >
            {TIME_RANGES.map((range) => (
              <option key={range} value={range}>
                {TIME_RANGE_LABELS[range]}
              </option>
            ))}
          </select>
        </label>

        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={state.page <= 1}
              onClick={() => onPageChange(state.page - 1)}
              className="rounded-lg border border-slate-200 p-1.5 text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="px-1 text-sm text-slate-500">
              Page {state.page} of {totalPages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={state.page >= totalPages}
              onClick={() => onPageChange(state.page + 1)}
              className="rounded-lg border border-slate-200 p-1.5 text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

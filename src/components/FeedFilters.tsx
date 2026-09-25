"use client";

import type { BrowseSort, SearchSort } from "@/lib/searchState";

const filters = ["All", "News", "Papers", "GitHub", "Hacker News", "Discussions", "Bookmarks"] as const;
export type FilterValue = (typeof filters)[number];

const SORT_LABELS: Record<BrowseSort | SearchSort, string> = {
  latest: "Latest",
  top: "Top",
  discussed: "Most Discussed",
  relevance: "Relevance",
  newest: "Newest",
};

export interface PublisherOption {
  id: string;
  name: string;
}

interface FeedFiltersProps {
  active: FilterValue;
  onChange: (value: FilterValue) => void;
  sort: BrowseSort | SearchSort;
  onSortChange: (value: BrowseSort | SearchSort) => void;
  /** The sorts that actually change results for this view — see
   * `getAvailableSorts` in searchState.ts (the single source of truth).
   * Two or more render a selector; a single option can't be a choice, so
   * it renders as a plain, non-interactive label instead. */
  sortOptions: readonly (BrowseSort | SearchSort)[];
  /** Overrides the label shown for a single, fixed ranking (e.g.
   * "Similarity" for Semantic results). Ignored when a selector renders. */
  fixedSortLabel?: string;
  /** Step 27: publisher identity within the current source type — e.g. the
   * 7 RSS publishers sharing the "News" source type. Only meaningful (and
   * only passed non-empty) on the News tab, where multiple publishers
   * exist; every other tab already IS one publisher, so a redundant
   * dropdown there would just be clutter (Step 27 §5). Rendered here,
   * beside Sort, so it's reachable while just browsing — not hidden behind
   * an already-active search the way it originally was (Step 27 §1 audit
   * finding: the publisher filter existed end-to-end in the URL/DB layer
   * since Step 18, but its only UI was nested inside the search-results
   * bar, which doesn't render until a query/time filter is already set). */
  publisherOptions?: PublisherOption[];
  selectedSource?: string;
  onSourceChange?: (source: string | undefined) => void;
}

export function FeedFilters({
  active,
  onChange,
  sort,
  onSortChange,
  sortOptions,
  fixedSortLabel,
  publisherOptions = [],
  selectedSource,
  onSourceChange,
}: FeedFiltersProps) {
  const hasSortChoice = sortOptions.length > 1;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div role="tablist" aria-label="Feed filters" className="flex flex-wrap gap-2">
        {filters.map((filter) => {
          const isActive = filter === active;
          return (
            <button
              key={filter}
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(filter)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-blue-600 text-white shadow-sm"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {filter}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {publisherOptions.length > 0 && onSourceChange && (
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <span className="sr-only">Publisher</span>
            <select
              value={selectedSource ?? ""}
              onChange={(e) => onSourceChange(e.target.value || undefined)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            >
              <option value="">All publishers</option>
              {publisherOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {hasSortChoice ? (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span className="sr-only">Sort by</span>
            <select
              value={sort}
              onChange={(e) => onSortChange(e.target.value as BrowseSort | SearchSort)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            >
              {sortOptions.map((option) => (
                <option key={option} value={option}>
                  {SORT_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-sm text-slate-600">
            Sorted by <span className="font-medium text-slate-700">{fixedSortLabel ?? SORT_LABELS[sortOptions[0] ?? sort]}</span>
          </p>
        )}
      </div>
    </div>
  );
}

export { filters };

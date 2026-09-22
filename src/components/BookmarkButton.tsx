"use client";

import { Bookmark, AlertTriangle } from "lucide-react";
import { addBookmarkAction, removeBookmarkAction } from "@/app/actions/bookmarks";
import { useOptimisticToggle } from "@/lib/useOptimisticToggle";

interface BookmarkButtonProps {
  sourceKey: string;
  initialBookmarked: boolean;
  /** Icon-only, no label/error text inline — for dense list contexts (the
   * Step 22 briefing cards) where the full labeled button would be too
   * heavy. Same optimistic toggle logic either way; only the rendering
   * differs. Errors still surface via `title`/`aria-label` rather than
   * being silently dropped. */
  compact?: boolean;
}

/**
 * Self-contained bookmark toggle — same optimistic update / rollback-on-
 * failure pattern as DashboardClient's card toggle, just without a shared
 * parent state map (each usage only ever renders its own single item, so
 * there's nothing to keep in sync with).
 */
export function BookmarkButton({ sourceKey, initialBookmarked, compact = false }: BookmarkButtonProps) {
  const {
    value: bookmarked,
    pending,
    error,
    toggle,
  } = useOptimisticToggle(initialBookmarked, (next) =>
    next ? addBookmarkAction(sourceKey) : removeBookmarkAction(sourceKey)
  );

  const handleClick = () => {
    void toggle("Couldn't save bookmark. Try again.");
  };

  if (compact) {
    const label = error ?? (bookmarked ? "Bookmarked — click to remove" : "Bookmark this item");
    return (
      <button
        type="button"
        aria-pressed={bookmarked}
        aria-label={label}
        title={label}
        disabled={pending}
        onClick={handleClick}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60 ${
          error
            ? "text-red-500"
            : bookmarked
              ? "text-blue-600 hover:bg-blue-50"
              : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        }`}
      >
        {error ? <AlertTriangle size={15} /> : <Bookmark size={15} fill={bookmarked ? "currentColor" : "none"} />}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-pressed={bookmarked}
        disabled={pending}
        onClick={handleClick}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60 ${
          bookmarked
            ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
            : "border-slate-200 text-slate-600 hover:bg-slate-50"
        }`}
      >
        <Bookmark size={15} fill={bookmarked ? "currentColor" : "none"} />
        {bookmarked ? "Bookmarked" : "Bookmark"}
      </button>
      {error && (
        <span role="alert" className="flex items-center gap-1 text-xs font-medium text-red-600">
          <AlertTriangle size={12} />
          {error}
        </span>
      )}
    </div>
  );
}

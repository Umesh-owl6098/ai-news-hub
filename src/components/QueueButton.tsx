"use client";

import { Clock, AlertTriangle } from "lucide-react";
import { addToQueueAction, removeFromQueueAction } from "@/app/actions/readingState";
import { useOptimisticToggle } from "@/lib/useOptimisticToggle";

interface QueueButtonProps {
  sourceKey: string;
  initialQueued: boolean;
  /** Icon-only, no label text inline — for dense list contexts. Same
   * optimistic toggle logic either way; only the rendering differs. */
  compact?: boolean;
  /** Optional: fires only after a persisted (not optimistic) queue
   * change — for a caller keeping its own derived view in sync, e.g.
   * /queue's row list and counts. See useOptimisticToggle's onSuccess. */
  onSuccess?: (queued: boolean) => void;
}

/**
 * Self-contained queue toggle — same optimistic update / rollback-on-
 * failure pattern as BookmarkButton (via the shared useOptimisticToggle
 * hook), independent of bookmark and read state (Step 26 §3).
 */
export function QueueButton({ sourceKey, initialQueued, compact = false, onSuccess }: QueueButtonProps) {
  const {
    value: queued,
    pending,
    error,
    toggle,
  } = useOptimisticToggle(
    initialQueued,
    (next) => (next ? addToQueueAction(sourceKey) : removeFromQueueAction(sourceKey)),
    onSuccess
  );

  const handleClick = () => {
    void toggle("Couldn't update the reading queue. Try again.");
  };

  if (compact) {
    const label = error ?? (queued ? "Remove from reading queue" : "Add to reading queue");
    return (
      <button
        type="button"
        aria-pressed={queued}
        aria-label={label}
        title={label}
        disabled={pending}
        onClick={handleClick}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60 ${
          error
            ? "text-red-500"
            : queued
              ? "text-blue-600 hover:bg-blue-50"
              : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        }`}
      >
        {error ? <AlertTriangle size={15} /> : <Clock size={15} fill={queued ? "currentColor" : "none"} />}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-pressed={queued}
        disabled={pending}
        onClick={handleClick}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60 ${
          queued
            ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
            : "border-slate-200 text-slate-600 hover:bg-slate-50"
        }`}
      >
        <Clock size={15} fill={queued ? "currentColor" : "none"} />
        {queued ? "In queue" : "Add to queue"}
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

"use client";

import { CheckCircle2, Circle, AlertTriangle } from "lucide-react";
import { markReadAction, markUnreadAction } from "@/app/actions/readingState";
import { useOptimisticToggle } from "@/lib/useOptimisticToggle";

interface ReadToggleButtonProps {
  sourceKey: string;
  initialRead: boolean;
  /** Icon-only, no label text inline — for dense list contexts. Same
   * optimistic toggle logic either way; only the rendering differs. */
  compact?: boolean;
}

/**
 * Self-contained read/unread toggle — same optimistic update / rollback-
 * on-failure pattern as BookmarkButton and QueueButton (via the shared
 * useOptimisticToggle hook), independent of queue and bookmark state
 * (Step 26 §3). Restrained presentation per §12/§5 — a read item stays
 * fully legible, never faded to near-illegibility.
 */
export function ReadToggleButton({ sourceKey, initialRead, compact = false }: ReadToggleButtonProps) {
  const {
    value: read,
    pending,
    error,
    toggle,
  } = useOptimisticToggle(initialRead, (next) => (next ? markReadAction(sourceKey) : markUnreadAction(sourceKey)));

  const handleClick = () => {
    void toggle("Couldn't update read state. Try again.");
  };

  if (compact) {
    const label = error ?? (read ? "Read — click to mark unread" : "Mark as read");
    return (
      <button
        type="button"
        aria-pressed={read}
        aria-label={label}
        title={label}
        disabled={pending}
        onClick={handleClick}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60 ${
          error ? "text-red-500" : read ? "text-emerald-600 hover:bg-emerald-50" : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        }`}
      >
        {error ? <AlertTriangle size={15} /> : read ? <CheckCircle2 size={15} /> : <Circle size={15} />}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-pressed={read}
        disabled={pending}
        onClick={handleClick}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60 ${
          read
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            : "border-slate-200 text-slate-600 hover:bg-slate-50"
        }`}
      >
        {read ? <CheckCircle2 size={15} /> : <Circle size={15} />}
        {read ? "Read" : "Mark as read"}
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

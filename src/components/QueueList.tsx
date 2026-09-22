"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { QueueItemRow } from "@/db/repository";
import { QueueRow } from "@/components/QueueRow";
import {
  applyDequeueSuccess,
  applyReadSuccess,
  deriveQueueView,
  QUEUE_STATUS_VALUES,
  type QueueStatus,
} from "@/lib/queueListState";

export type { QueueStatus };

const STATUS_VALUES = QUEUE_STATUS_VALUES;
const STATUS_LABELS: Record<QueueStatus, string> = { all: "All", unread: "Unread", read: "Read" };
const DEFAULT_STATUS: QueueStatus = "all";

interface QueueListProps {
  items: QueueItemRow[];
  status: QueueStatus;
}

/**
 * V1 verification-closure fix — the queue list and its All/Unread/Read
 * counts used to be rendered entirely server-side, so a row's own
 * dequeue/mark-read/mark-unread button updated only its own optimistic
 * icon: the row itself stayed in the list and the header counts stayed
 * stale until the next navigation or reload. `QueuePage` now fetches the
 * full (unfiltered) queue once and hands it to this client component,
 * which keeps its own copy of that list and derives the filtered rows +
 * counts from it on every render — so a *persisted* mutation (never an
 * optimistic one; see useOptimisticToggle's onSuccess) immediately
 * updates both.
 *
 * `items` only ever changes identity when the server actually re-renders
 * `QueuePage` (a real navigation, or Step 29's PopstateRefresh forcing
 * one on back/forward) — never from this component's own local state
 * changes — so resyncing from it can't clobber an in-flight local
 * mutation, and correctly picks up state changed through a *different*
 * UI (e.g. toggling read state on an item's detail page, then hitting
 * Back) exactly the way useOptimisticToggle's own initialValue resync
 * does for a single button. Adjusted during render (the documented React
 * pattern — react.dev/learn/you-might-not-need-an-effect), not in a
 * useEffect, to avoid an extra cascading render — same reasoning as
 * SearchBar.tsx's own query resync.
 */
export function QueueList({ items: initialItems, status }: QueueListProps) {
  const [items, setItems] = useState(initialItems);
  const [prevInitialItems, setPrevInitialItems] = useState(initialItems);
  if (initialItems !== prevInitialItems) {
    setPrevInitialItems(initialItems);
    setItems(initialItems);
  }

  const { filteredItems, unreadCount, readCount } = useMemo(() => deriveQueueView(items, status), [items, status]);

  const handleDequeueSuccess = (sourceKey: string) => (queued: boolean) => {
    setItems((current) => applyDequeueSuccess(current, sourceKey, queued));
  };

  const handleReadSuccess = (sourceKey: string) => (read: boolean) => {
    setItems((current) => applyReadSuccess(current, sourceKey, read));
  };

  return (
    <>
      <nav aria-label="Read status" className="mt-4 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm w-fit">
        {STATUS_VALUES.map((s) => (
          <Link
            key={s}
            href={s === DEFAULT_STATUS ? "/queue" : `/queue?status=${s}`}
            aria-current={s === status ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
              s === status ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {STATUS_LABELS[s]}
            {s === "unread" && unreadCount > 0 ? ` (${unreadCount})` : ""}
            {s === "read" && readCount > 0 ? ` (${readCount})` : ""}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          Your reading queue is empty — use the clock icon on any item to save it here for later.
        </p>
      ) : filteredItems.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No {STATUS_LABELS[status].toLowerCase()} items in your queue.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white px-1 shadow-sm">
          {filteredItems.map((row) => (
            <QueueRow
              key={row.item.id}
              item={row.item}
              read={row.read}
              bookmarked={row.bookmarked}
              onQueueSuccess={handleDequeueSuccess(row.item.id)}
              onReadSuccess={handleReadSuccess(row.item.id)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

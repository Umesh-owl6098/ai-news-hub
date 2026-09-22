import type { QueueItemRow } from "@/db/repository";

export const QUEUE_STATUS_VALUES = ["all", "unread", "read"] as const;
export type QueueStatus = (typeof QUEUE_STATUS_VALUES)[number];

/**
 * Pure state transitions for /queue's client-side list (`QueueList.tsx`).
 * Extracted so the actual queue-consistency behavior — what a *persisted*
 * dequeue/mark-read/mark-unread does to the row list and the All/Unread/
 * Read counts — is unit-testable directly, without needing a DOM/React
 * rendering environment this codebase doesn't otherwise have (see
 * step29AuditFixes.test.ts's own note on this). These are called only
 * from `useOptimisticToggle`'s `onSuccess`, which fires exclusively when
 * the server action reported `ok: true` — a failed mutation never reaches
 * here, so the previous (correct) list/count state is left untouched.
 */

export function applyDequeueSuccess(items: QueueItemRow[], sourceKey: string, queued: boolean): QueueItemRow[] {
  // This page only ever offers "remove from queue" (every row starts
  // queued), so a queued:true success is a no-op for the list.
  if (queued) return items;
  return items.filter((row) => row.item.id !== sourceKey);
}

export function applyReadSuccess(items: QueueItemRow[], sourceKey: string, read: boolean): QueueItemRow[] {
  return items.map((row) => (row.item.id === sourceKey ? { ...row, read } : row));
}

export interface QueueView {
  filteredItems: QueueItemRow[];
  unreadCount: number;
  readCount: number;
}

export function deriveQueueView(items: QueueItemRow[], status: QueueStatus): QueueView {
  const unreadCount = items.filter((row) => !row.read).length;
  const readCount = items.length - unreadCount;

  const filteredItems = items.filter((row) => {
    if (status === "unread") return !row.read;
    if (status === "read") return row.read;
    return true;
  });

  return { filteredItems, unreadCount, readCount };
}

import Link from "next/link";
import type { FeedItem } from "@/types/feed";
import { sourceMeta } from "@/lib/sourceDisplay";
import { formatRelativeTime } from "@/lib/time";
import { BookmarkButton } from "@/components/BookmarkButton";
import { QueueButton } from "@/components/QueueButton";
import { ReadToggleButton } from "@/components/ReadToggleButton";

interface QueueRowProps {
  item: FeedItem;
  read: boolean;
  bookmarked: boolean;
  /** Optional: notified after a persisted (not optimistic) queue/read
   * change, so a parent list can update its own row/count state without
   * a page reload. See QueueButton/ReadToggleButton's onSuccess. */
  onQueueSuccess?: (queued: boolean) => void;
  onReadSuccess?: (read: boolean) => void;
}

/**
 * A single compact /queue row — a practical reading list, not another
 * dashboard (Step 26 §4). Every item here is, by construction, currently
 * queued, so its `QueueButton` always starts "on" and functions as
 * "remove from queue." Read state is shown restrained (an outline vs.
 * filled check icon, never extreme opacity) per §5/§12.
 */
export function QueueRow({ item, read, bookmarked, onQueueSuccess, onReadSuccess }: QueueRowProps) {
  const meta = sourceMeta[item.sourceType];
  const Icon = meta.icon;
  const href = item.dbId != null ? `/item/${item.dbId}` : item.url;

  return (
    <li className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-slate-50">
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.color}`}>
        <Icon size={13} />
      </span>

      <Link href={href} className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
        <p className="truncate text-sm font-medium text-slate-900">{item.title}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
          <span>{item.sourceName}</span>
          <span aria-hidden="true">&middot;</span>
          <time dateTime={item.publishedAt}>{formatRelativeTime(item.publishedAt)}</time>
        </div>
      </Link>

      <div className="flex shrink-0 items-center gap-0.5">
        <ReadToggleButton sourceKey={item.id} initialRead={read} compact onSuccess={onReadSuccess} />
        <QueueButton sourceKey={item.id} initialQueued compact onSuccess={onQueueSuccess} />
        <BookmarkButton sourceKey={item.id} initialBookmarked={bookmarked} compact />
      </div>
    </li>
  );
}

import Link from "next/link";
import { ArrowUpCircle, MessageCircle, Star } from "lucide-react";
import type { FeedItem } from "@/types/feed";
import { sourceMeta } from "@/lib/sourceDisplay";
import { formatRelativeTime } from "@/lib/time";
import { BookmarkButton } from "@/components/BookmarkButton";
import { QueueButton } from "@/components/QueueButton";

const compactNumberFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/**
 * The one factual, source-native detail worth a briefing row — never an
 * invented or cross-source-compared number (Step 22 §3/§5). Each source
 * type gets at most one such detail so rows stay scannable; everything
 * else about the item lives on its `/item/[id]` detail page. Returns
 * `null` (rendering nothing, no dangling separator) for source types with
 * no such native metric — RSS news has no engagement data, and fabricating
 * one is exactly what this milestone rules out.
 */
function factualDetail(item: FeedItem): React.ReactNode {
  if (item.sourceType === "hackernews") {
    return (
      <span className="flex items-center gap-1">
        <ArrowUpCircle size={12} />
        {item.score} points
        <span aria-hidden="true">·</span>
        <MessageCircle size={12} />
        {item.commentCount}
      </span>
    );
  }
  if (item.sourceType === "github" && typeof item.stars === "number") {
    return (
      <span className="flex items-center gap-1">
        <Star size={12} />
        {compactNumberFormatter.format(item.stars)} stars
      </span>
    );
  }
  if (item.sourceType === "paper" && item.tags.length > 0) {
    return <span>{item.tags[0]}</span>;
  }
  return null;
}

interface BriefingItemRowProps {
  item: FeedItem;
  bookmarked: boolean;
  queued: boolean;
  /** Step 28: the briefing's own reference instant — defaults to now (the
   * live briefing's existing behavior). A historical `/briefing?date=`
   * passes its end-of-day reference instant here so "2d ago" reads
   * relative to the date being viewed, not to today. */
  referenceInstant?: Date;
}

/**
 * A single, compact, scannable briefing row — deliberately lighter-weight
 * than the main feed's `FeedCard` (large cards with full metadata/AI
 * summary panels): the briefing's job is fast triage across many items,
 * not a full read. Server-renderable; the only interactive piece is the
 * bookmark toggle, an independent client leaf.
 */
export function BriefingItemRow({ item, bookmarked, queued, referenceInstant }: BriefingItemRowProps) {
  const meta = sourceMeta[item.sourceType];
  const Icon = meta.icon;
  const href = item.dbId != null ? `/item/${item.dbId}` : item.url;
  const detail = factualDetail(item);

  return (
    <li className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-slate-50">
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.color}`}>
        <Icon size={13} />
      </span>

      <Link href={href} className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
        <p className="truncate text-sm font-medium text-slate-900">{item.title}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
          <span>{item.sourceName}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={item.publishedAt}>{formatRelativeTime(item.publishedAt, referenceInstant)}</time>
          {detail && (
            <>
              <span aria-hidden="true">·</span>
              {detail}
            </>
          )}
        </div>
      </Link>

      <div className="flex shrink-0 items-center gap-0.5">
        <QueueButton sourceKey={item.id} initialQueued={queued} compact />
        <BookmarkButton sourceKey={item.id} initialBookmarked={bookmarked} compact />
      </div>
    </li>
  );
}

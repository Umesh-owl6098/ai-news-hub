"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowUpCircle,
  MessageCircle,
  MessageSquareText,
  Bookmark,
  Clock,
  ExternalLink,
  FileDown,
  Star,
  GitFork,
  Sparkles,
} from "lucide-react";
import { FeedItem } from "@/types/feed";
import { TopicChip } from "@/components/TopicChip";
import { formatRelativeTime } from "@/lib/time";
import { sourceMeta } from "@/lib/sourceDisplay";

const compactNumberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value);
}

const MAX_VISIBLE_AUTHORS = 2;

function formatAuthors(authors: string[]): string {
  if (authors.length <= MAX_VISIBLE_AUTHORS) return authors.join(", ");
  const shown = authors.slice(0, MAX_VISIBLE_AUTHORS).join(", ");
  return `${shown}, +${authors.length - MAX_VISIBLE_AUTHORS} more`;
}

// Step 24: persisted `tags` can now hold up to MAX_FEED_ITEM_TAGS (20) —
// a real improvement for Topics/search, but a card showing 20 chips
// would be cluttered. This caps what's DISPLAYED only; the full list
// still exists in the data and on the /item/[id] detail page.
const MAX_VISIBLE_TAGS = 5;

/** AI-generated metadata for this item, if any (see Step 9). Absent for
 * most items — the card renders exactly as it did before this existed. */
export interface FeedCardEnrichment {
  summary: string;
  topics: string[];
}

interface FeedCardProps {
  item: FeedItem;
  bookmarked: boolean;
  /** True while a bookmark add/remove request for this item is in flight —
   * disables the control so a double-click can't fire a duplicate request. */
  bookmarkPending?: boolean;
  onToggleBookmark: (item: FeedItem) => void;
  /** Step 26: a minimal, queue-ONLY control (no read/unread here) — full
   * queue + read state controls live on /item/[id] and /queue instead, per
   * that milestone's "don't overcrowd cards" guidance. */
  queued?: boolean;
  queuePending?: boolean;
  onToggleQueue?: (item: FeedItem) => void;
  enrichment?: FeedCardEnrichment | null;
}

export function FeedCard({
  item,
  bookmarked,
  bookmarkPending = false,
  onToggleBookmark,
  queued = false,
  queuePending = false,
  onToggleQueue,
  enrichment = null,
}: FeedCardProps) {
  const { icon: SourceIcon, color } = sourceMeta[item.sourceType];
  // arXiv, GitHub, and RSS news have no upvote/comment concept; GitHub gets
  // its own stars/forks/language row instead (rendered below).
  const showEngagement =
    item.sourceType !== "paper" && item.sourceType !== "github" && item.sourceType !== "news";
  const showGithubMeta = item.sourceType === "github";

  return (
    <article className="flex gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
      {item.thumbnailUrl && (
        <div className="hidden sm:block shrink-0">
          <Image
            src={item.thumbnailUrl}
            alt=""
            width={112}
            height={80}
            className="h-20 w-28 rounded-lg object-cover"
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${color}`}>
            <SourceIcon size={12} />
            {item.sourceName}
          </span>
          <span aria-hidden="true">&middot;</span>
          <time dateTime={item.publishedAt}>{formatRelativeTime(item.publishedAt)}</time>
        </div>

        <h2 className="text-sm font-semibold text-slate-900 leading-snug">
          {/* Only DB-backed items (search, semantic, bookmarks, the normal
           * browse path) have a resolvable detail page — a mock fixture or
           * a live-fetch-without-DB-round-trip item keeps its original
           * direct-to-source behavior instead of linking to a 404. */}
          {item.dbId !== undefined ? (
            <Link href={`/item/${item.dbId}`} className="hover:underline">
              {item.title}
            </Link>
          ) : (
            <a href={item.url} className="hover:underline" target="_blank" rel="noreferrer noopener">
              {item.title}
            </a>
          )}
        </h2>

        {item.authors && item.authors.length > 0 ? (
          <p className="text-xs text-slate-500">{formatAuthors(item.authors)}</p>
        ) : (
          item.owner && <p className="text-xs text-slate-500">{item.owner}</p>
        )}

        <p className="text-sm text-slate-600 line-clamp-2">{item.description}</p>

        {item.tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {item.tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
              <TopicChip key={tag} label={tag} />
            ))}
            {item.tags.length > MAX_VISIBLE_TAGS && (
              <span className="text-xs text-slate-400">+{item.tags.length - MAX_VISIBLE_TAGS} more</span>
            )}
          </div>
        )}

        {enrichment && (
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-2">
            <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-600">
              <Sparkles size={11} />
              AI Summary
            </p>
            <p className="mt-1 text-xs leading-snug text-slate-700">{enrichment.summary}</p>
            {enrichment.topics.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {enrichment.topics.map((topic) => (
                  <span
                    key={topic}
                    className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700"
                  >
                    {topic}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-1 flex items-center justify-between">
          {showGithubMeta ? (
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <Star size={14} />
                {formatCompactNumber(item.stars ?? 0)}
              </span>
              <span className="flex items-center gap-1">
                <GitFork size={14} />
                {formatCompactNumber(item.forks ?? 0)}
              </span>
              {item.language && <span>{item.language}</span>}
            </div>
          ) : showEngagement ? (
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <ArrowUpCircle size={14} />
                {item.score}
              </span>
              <span className="flex items-center gap-1">
                <MessageCircle size={14} />
                {item.commentCount}
              </span>
            </div>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-pressed={bookmarked}
              aria-label={bookmarked ? "Remove bookmark" : "Bookmark this item"}
              title={bookmarked ? "Remove bookmark" : "Bookmark this item"}
              disabled={bookmarkPending}
              onClick={() => onToggleBookmark(item)}
              className={`rounded-md p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60 ${
                bookmarked ? "text-blue-600" : "text-slate-400 hover:text-slate-600"
              }`}
            >
              <Bookmark size={16} fill={bookmarked ? "currentColor" : "none"} />
            </button>
            {onToggleQueue && (
              <button
                type="button"
                aria-pressed={queued}
                aria-label={queued ? "Remove from reading queue" : "Add to reading queue"}
                title={queued ? "Remove from reading queue" : "Add to reading queue"}
                disabled={queuePending}
                onClick={() => onToggleQueue(item)}
                className={`rounded-md p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-60 ${
                  queued ? "text-blue-600" : "text-slate-400 hover:text-slate-600"
                }`}
              >
                <Clock size={16} fill={queued ? "currentColor" : "none"} />
              </button>
            )}
            {item.discussionUrl && item.discussionUrl !== item.url && (
              <a
                href={item.discussionUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open Hacker News discussion"
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:text-slate-600"
              >
                <MessageSquareText size={16} />
              </a>
            )}
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open original source"
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:text-slate-600"
            >
              <ExternalLink size={16} />
            </a>
            {item.pdfUrl && (
              <a
                href={item.pdfUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Open PDF"
                className="rounded-md p-1.5 text-slate-400 transition-colors hover:text-slate-600"
              >
                <FileDown size={16} />
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

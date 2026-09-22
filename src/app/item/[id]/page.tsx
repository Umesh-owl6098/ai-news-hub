import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ExternalLink,
  FileDown,
  MessageSquareText,
  Star,
  GitFork,
  ArrowUpCircle,
  MessageCircle,
  Sparkles,
  Quote,
} from "lucide-react";
import {
  getFeedItemById,
  getEnrichmentByFeedItemId,
  getHnContextCache,
  getBookmarkedSourceKeys,
  getReadingStateKeys,
  getRelatedFeedItems,
} from "@/db/repository";
import { formatRelativeTime } from "@/lib/time";
import { sourceMeta } from "@/lib/sourceDisplay";
import { TopicChip } from "@/components/TopicChip";
import { BackButton } from "@/components/BackButton";
import { BookmarkButton } from "@/components/BookmarkButton";
import { QueueButton } from "@/components/QueueButton";
import { ReadToggleButton } from "@/components/ReadToggleButton";
import type { FeedItem } from "@/types/feed";

const RELATED_ITEMS_LIMIT = 6;

const compactNumberFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function byline(item: FeedItem): string | null {
  if (item.authors && item.authors.length > 0) return item.authors.join(", ");
  if (item.owner) return item.owner;
  return null;
}

/**
 * Server-rendered, source-agnostic detail page for one already-ingested
 * feed item — see Step 19 final report for the architecture inspection
 * behind every choice here. Database reads only: no OpenAI call, no
 * embedding-provider call, no source-network call (HN/arXiv/GitHub/RSS) on
 * render. `id` is the internal numeric `feed_items.id` (a stable DB
 * identity), not the external `sourceKey` — an RSS sourceKey embeds a full
 * URL with slashes, which doesn't fit one dynamic route segment cleanly.
 *
 * Step 26 §8: opening this page must never mark the item read — read state
 * only ever changes from an explicit user click on the read-toggle control
 * below (a self-contained client component). This function reads reading
 * state (`getReadingStateKeys`) but never writes it.
 */
export default async function ItemDetailPage({ params }: PageProps<"/item/[id]">) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const item = await getFeedItemById(id);
  if (!item) notFound();

  const [enrichment, hnContext, bookmarkedKeys, readingStateKeys, related] = await Promise.all([
    getEnrichmentByFeedItemId(id),
    // Read-only cache peek — never resolveHnSourceContext, which can fetch
    // live from Hacker News. A no-op query for every non-HN source type.
    item.sourceType === "hackernews" ? getHnContextCache(id) : Promise.resolve(null),
    getBookmarkedSourceKeys(),
    getReadingStateKeys(),
    getRelatedFeedItems(id, RELATED_ITEMS_LIMIT),
  ]);

  const bookmarked = bookmarkedKeys.includes(item.id);
  const queued = readingStateKeys.queuedKeys.includes(item.id);
  const read = readingStateKeys.readKeys.includes(item.id);
  const hasCompletedEnrichment = enrichment?.status === "completed" && Boolean(enrichment.summary);
  const { icon: SourceIcon, color: sourceColor } = sourceMeta[item.sourceType];
  const line = byline(item);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
          <BackButton />
          <span aria-hidden="true" className="text-slate-300">
            |
          </span>
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-purple-600">
              <Sparkles size={13} className="text-white" />
            </span>
            AI News Hub
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <article>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-medium ${sourceColor}`}>
              <SourceIcon size={13} />
              {item.sourceName}
            </span>
            <span aria-hidden="true">&middot;</span>
            <time dateTime={item.publishedAt}>{formatRelativeTime(item.publishedAt)}</time>
          </div>

          <h1 className="mt-3 break-words text-2xl font-bold leading-tight text-slate-900 sm:text-3xl">
            {item.title}
          </h1>

          {line && <p className="mt-2 break-words text-sm text-slate-500">{line}</p>}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <BookmarkButton sourceKey={item.id} initialBookmarked={bookmarked} />
            <QueueButton sourceKey={item.id} initialQueued={queued} />
            <ReadToggleButton sourceKey={item.id} initialRead={read} />
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <ExternalLink size={15} />
              Open original source
            </a>
            {item.discussionUrl && item.discussionUrl !== item.url && (
              <a
                href={item.discussionUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <MessageSquareText size={15} />
                View discussion
              </a>
            )}
            {item.pdfUrl && (
              <a
                href={item.pdfUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <FileDown size={15} />
                PDF
              </a>
            )}
          </div>

          {item.description && (
            <p className="mt-6 whitespace-pre-line break-words text-base leading-relaxed text-slate-700">
              {item.description}
            </p>
          )}

          {item.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {item.tags.map((tag) => (
                <TopicChip key={tag} label={tag} />
              ))}
            </div>
          )}

          {item.sourceType === "github" && (
            <dl className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
              <div className="flex items-center gap-1.5">
                <Star size={15} />
                <dt className="sr-only">Stars</dt>
                <dd>{compactNumberFormatter.format(item.stars ?? 0)} stars</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <GitFork size={15} />
                <dt className="sr-only">Forks</dt>
                <dd>{compactNumberFormatter.format(item.forks ?? 0)} forks</dd>
              </div>
              {item.language && (
                <div>
                  <dt className="sr-only">Primary language</dt>
                  <dd>{item.language}</dd>
                </div>
              )}
            </dl>
          )}

          {item.sourceType === "hackernews" && (
            <dl className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
              <div className="flex items-center gap-1.5">
                <ArrowUpCircle size={15} />
                <dt className="sr-only">Points</dt>
                <dd>{item.score} points</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <MessageCircle size={15} />
                <dt className="sr-only">Comments</dt>
                <dd>{item.commentCount} comments</dd>
              </div>
            </dl>
          )}

          {hasCompletedEnrichment && (
            <section aria-labelledby="ai-summary-heading" className="mt-6 rounded-lg border border-indigo-100 bg-indigo-50/60 p-4">
              <h2
                id="ai-summary-heading"
                className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-indigo-600"
              >
                <Sparkles size={13} />
                AI Summary
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">{enrichment!.summary}</p>
              {enrichment!.topics && enrichment!.topics.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {enrichment!.topics.map((topic) => (
                    <span key={topic} className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700">
                      {topic}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-3 text-[11px] text-indigo-400">AI-generated — not written by {item.sourceName}.</p>
            </section>
          )}

          {hnContext?.status === "has_context" && (
            <section aria-labelledby="hn-context-heading" className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
              <h2 id="hn-context-heading" className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Quote size={13} />
                From the discussion
              </h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600">{hnContext.normalizedContext}</p>
              <p className="mt-3 text-[11px] text-slate-400">Cached excerpt from Hacker News — not the full thread.</p>
            </section>
          )}

          {related.length > 0 && (
            <section aria-labelledby="related-heading" className="mt-10 border-t border-slate-200 pt-6">
              <h2 id="related-heading" className="text-sm font-semibold text-slate-900">
                Related
              </h2>
              <ul className="mt-3 flex flex-col gap-1">
                {related.map(({ item: relatedItem, feedItemId: relatedId }) => {
                  const meta = sourceMeta[relatedItem.sourceType];
                  const RelatedIcon = meta.icon;
                  return (
                    <li key={relatedId}>
                      <Link
                        href={`/item/${relatedId}`}
                        className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-slate-700 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                      >
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${meta.color}`}>
                          <RelatedIcon size={12} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{relatedItem.title}</span>
                        <span className="shrink-0 text-xs text-slate-400">{formatRelativeTime(relatedItem.publishedAt)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </article>
      </main>
    </div>
  );
}

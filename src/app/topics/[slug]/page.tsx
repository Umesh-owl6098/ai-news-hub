import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { getFeedItemsForTopics } from "@/db/repository";
import { aggregateTopics, findTopicBySlug, TOPIC_WINDOWS, isTopicWindow, topicWindowToDays, MAX_TOPIC_WINDOW_DAYS, type TopicWindow } from "@/lib/topics";
import { sourceMeta } from "@/lib/sourceDisplay";
import { formatRelativeTime } from "@/lib/time";
import { BackButton } from "@/components/BackButton";
import type { SourceType } from "@/types/feed";

const WINDOW_LABELS: Record<TopicWindow, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const DEFAULT_WINDOW: TopicWindow = "7d";

function parseWindow(raw: string | string[] | undefined): TopicWindow {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && isTopicWindow(value) ? value : DEFAULT_WINDOW;
}

/**
 * Step 20 — one topic's full recent activity. Database-only, same
 * aggregation as the overview (`getFeedItemsForTopics` + `aggregateTopics`
 * — no separate topic table, the slug is recomputed from live data on
 * every request, exactly like the overview). `[slug]` is treated as an
 * opaque string to look up, never re-validated against a format — an
 * unrecognized slug simply matches nothing and 404s, the same outcome as
 * a malformed one.
 *
 * A slug that exists in the wider 30-day pool but has zero items in the
 * currently-selected narrower window is NOT a 404 — it's a real topic
 * with no recent activity at this window, rendered with an explicit
 * empty state rather than conflated with "this topic doesn't exist."
 */
export default async function TopicDetailPage({ params, searchParams }: PageProps<"/topics/[slug]">) {
  const { slug } = await params;
  const searchParamsResolved = await searchParams;
  const window = parseWindow(searchParamsResolved.window);

  const rows = await getFeedItemsForTopics({ sinceDays: topicWindowToDays(window) });
  const topics = aggregateTopics(rows);
  const topic = findTopicBySlug(topics, slug);

  // A topic absent from the requested window isn't necessarily "not
  // found" — it may just have no recent activity at this window. Only
  // fall back to the wider (30d) pool to settle that, and reuse whatever
  // display label it finds so the empty state still shows a readable
  // title instead of the raw slug.
  let wideTopicLabel: string | undefined;
  if (!topic) {
    const wideRows = topicWindowToDays(window) === MAX_TOPIC_WINDOW_DAYS ? rows : await getFeedItemsForTopics({ sinceDays: MAX_TOPIC_WINDOW_DAYS });
    const wideTopic = findTopicBySlug(topicWindowToDays(window) === MAX_TOPIC_WINDOW_DAYS ? topics : aggregateTopics(wideRows), slug);
    if (!wideTopic) notFound();
    wideTopicLabel = wideTopic.label;
  }

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
        <Link href="/topics" className="text-xs font-medium text-slate-500 hover:text-slate-700 hover:underline">
          &larr; All topics
        </Link>

        <h1 className="mt-2 text-2xl font-bold text-slate-900">{topic?.label ?? wideTopicLabel ?? slug}</h1>

        <nav aria-label="Time window" className="mt-4 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm w-fit">
          {TOPIC_WINDOWS.map((w) => (
            <Link
              key={w}
              href={w === DEFAULT_WINDOW ? `/topics/${slug}` : `/topics/${slug}?window=${w}`}
              aria-current={w === window ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                w === window ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {WINDOW_LABELS[w]}
            </Link>
          ))}
        </nav>

        {!topic ? (
          <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No items for this topic in the last {WINDOW_LABELS[window]}. Try a wider window above.
          </p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-500">
                {topic.totalCount} item{topic.totalCount === 1 ? "" : "s"} in the last {WINDOW_LABELS[window]}
              </span>
              {(Object.entries(topic.sourceTypeCounts) as [SourceType, number][]).map(([sourceType, count]) => {
                const meta = sourceMeta[sourceType];
                const Icon = meta.icon;
                return (
                  <span key={sourceType} className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.color}`}>
                    <Icon size={12} />
                    {count}
                  </span>
                );
              })}
              {topic.distinctPublisherCount > 1 && (
                <span className="text-xs text-slate-400">{topic.distinctPublisherCount} publishers</span>
              )}
            </div>

            <ul className="mt-6 flex flex-col gap-2">
              {topic.items.map((item) => {
                const meta = sourceMeta[item.sourceType];
                const Icon = meta.icon;
                return (
                  <li key={item.dbId}>
                    <Link
                      href={item.dbId !== undefined ? `/item/${item.dbId}` : item.url}
                      target={item.dbId !== undefined ? undefined : "_blank"}
                      rel={item.dbId !== undefined ? undefined : "noreferrer noopener"}
                      className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                    >
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.color}`}>
                        <Icon size={13} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{item.title}</span>
                        <span className="block text-xs text-slate-500">{item.sourceName}</span>
                      </span>
                      <span className="shrink-0 text-xs text-slate-400">{formatRelativeTime(item.publishedAt)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

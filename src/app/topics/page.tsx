import Link from "next/link";
import { Sparkles } from "lucide-react";
import { getFeedItemsForTopics } from "@/db/repository";
import { aggregateTopics, TOPIC_WINDOWS, isTopicWindow, topicWindowToDays, type TopicWindow } from "@/lib/topics";
import { sourceMeta } from "@/lib/sourceDisplay";
import { BackButton } from "@/components/BackButton";
import type { SourceType } from "@/types/feed";

const WINDOW_LABELS: Record<TopicWindow, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const DEFAULT_WINDOW: TopicWindow = "7d";
const MAX_OVERVIEW_TOPICS = 30;
const REPRESENTATIVE_ITEMS_PREVIEW = 3;

function parseWindow(raw: string | string[] | undefined): TopicWindow {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && isTopicWindow(value) ? value : DEFAULT_WINDOW;
}

/**
 * Step 20 — Topics overview. Database-only: one bounded, time-windowed
 * query (`getFeedItemsForTopics`) plus in-process aggregation
 * (`aggregateTopics`) — no OpenAI call, no embedding call, no source
 * network call. See the Step 20 final report for why this shows absolute
 * recent-activity counts per topic rather than a recent-vs-previous
 * "trend": this corpus's publish timestamps are too bursty/ingestion-
 * driven for a defensible acceleration metric.
 */
export default async function TopicsPage({ searchParams }: PageProps<"/topics">) {
  const params = await searchParams;
  const window = parseWindow(params.window);

  const rows = await getFeedItemsForTopics({ sinceDays: topicWindowToDays(window) });
  const topics = aggregateTopics(rows).slice(0, MAX_OVERVIEW_TOPICS);

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
        <h1 className="text-2xl font-bold text-slate-900">Topics</h1>
        <p className="mt-1 text-sm text-slate-500">Subjects showing up across your AI news stream, grouped from existing tags and categories.</p>

        <nav aria-label="Time window" className="mt-5 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 text-sm w-fit">
          {TOPIC_WINDOWS.map((w) => (
            <Link
              key={w}
              href={w === DEFAULT_WINDOW ? "/topics" : `/topics?window=${w}`}
              aria-current={w === window ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                w === window ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {WINDOW_LABELS[w]}
            </Link>
          ))}
        </nav>

        <p className="mt-4 text-xs text-slate-400">
          {topics.length === 0
            ? `No tagged activity in the last ${WINDOW_LABELS[window]}.`
            : `${topics.length} topic${topics.length === 1 ? "" : "s"} from ${rows.length} tagged item${rows.length === 1 ? "" : "s"} in the last ${WINDOW_LABELS[window]}.`}
        </p>

        {topics.length === 0 && (
          <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            Try a wider window — this app&apos;s ingestion runs in bursts rather than a steady daily stream.
          </p>
        )}

        <ul className="mt-4 flex flex-col gap-2">
          {topics.map((topic) => (
            <li key={topic.slug}>
              <Link
                href={`/topics/${topic.slug}${window === DEFAULT_WINDOW ? "" : `?window=${window}`}`}
                className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">{topic.label}</h2>
                  <span className="text-xs font-medium text-slate-500">
                    {topic.totalCount} item{topic.totalCount === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(Object.entries(topic.sourceTypeCounts) as [SourceType, number][]).map(([sourceType, count]) => {
                    const meta = sourceMeta[sourceType];
                    const Icon = meta.icon;
                    return (
                      <span
                        key={sourceType}
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.color}`}
                      >
                        <Icon size={11} />
                        {count}
                      </span>
                    );
                  })}
                  {topic.distinctPublisherCount > 1 && (
                    <span className="text-[11px] text-slate-400">{topic.distinctPublisherCount} publishers</span>
                  )}
                </div>

                <p className="mt-2 truncate text-xs text-slate-500">
                  {topic.items
                    .slice(0, REPRESENTATIVE_ITEMS_PREVIEW)
                    .map((item) => item.title)
                    .join(" · ")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

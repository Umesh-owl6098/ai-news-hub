import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { Sparkles } from "lucide-react";
import {
  getFeedItemsForBriefing,
  getAllSourceHealth,
  getBookmarkedSourceKeys,
  getReadingStateKeys,
  getFeedItemsForTopics,
} from "@/db/repository";
import { buildBriefing, summarizeSourceFreshness, ACTIVE_TOPICS_LIMIT } from "@/lib/briefing";
import { resolveBriefingDate, shiftBriefingDate, formatBriefingDate } from "@/lib/briefingDate";
import { aggregateTopics, topicWindowToDays } from "@/lib/topics";
import { formatRelativeTime } from "@/lib/time";
import { BackButton } from "@/components/BackButton";
import { BriefingItemRow } from "@/components/BriefingItemRow";
import { BriefingRefreshButton } from "@/components/BriefingRefreshButton";
import { BriefingDatePicker } from "@/components/BriefingDatePicker";
import type { FeedItem } from "@/types/feed";

const WINDOW_LABEL = "3 days";
/** Reuses Step 20's existing "7d" topic window as-is — no new window value
 * introduced, per this milestone's "don't change the Topics algorithm"
 * boundary. A wider window than the briefing's own 72h is deliberate:
 * topic *activity* is meaningful over a slightly longer horizon than
 * "what's new today," and Step 20 already found 24h too bursty/sparse for
 * this corpus. */
const ACTIVE_TOPICS_SINCE_DAYS = topicWindowToDays("7d");

const DATE_HEADING_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Sep 20, 2026" from a "YYYY-MM-DD" string, formatted in the application
 * timezone (UTC — see briefingDate.ts) regardless of the server's own
 * local timezone. */
function formatDateHeading(dateStr: string): string {
  // Deliberately parsed as an explicit UTC midnight, not `new Date(dateStr)`
  // (which some engines interpret as local time for a bare date string) —
  // this only needs to *display* the calendar date, never a real instant.
  return DATE_HEADING_FORMATTER.format(new Date(`${dateStr}T00:00:00.000Z`));
}

function BriefingSection({
  title,
  subtitle,
  items,
  bookmarked,
  queued,
  referenceInstant,
}: {
  title: string;
  subtitle?: string;
  items: FeedItem[];
  bookmarked: Set<string>;
  queued: Set<string>;
  referenceInstant: Date;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <span className="text-xs text-slate-400">{subtitle}</span>}
      </div>
      <ul className="mt-2 flex flex-col divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white px-1 shadow-sm">
        {items.map((item) => (
          <BriefingItemRow
            key={item.id}
            item={item}
            bookmarked={bookmarked.has(item.id)}
            queued={queued.has(item.id)}
            referenceInstant={referenceInstant}
          />
        ))}
      </ul>
    </section>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

/**
 * Step 22 (current) / Step 28 (historical) — a deterministic,
 * database-only briefing, either for "now" (no `?date=`) or reconstructed
 * for a past calendar date (`?date=YYYY-MM-DD`, application timezone
 * UTC — see briefingDate.ts for the full semantics: eligibility window,
 * future/invalid-date handling, and the first-ingestion caveat). Every
 * read here is a plain persisted-data query (bounded candidate pool,
 * topic tags, and — today only — source health/bookmarks/queue state):
 * no source-network call, no OpenAI/embedding call. Opening this page
 * never refreshes or mutates anything (see BriefingRefreshButton for the
 * one explicit, user-initiated exception, shown only for today).
 */
export default async function BriefingPage({ searchParams }: PageProps<"/briefing">) {
  const params = await searchParams;
  const resolution = resolveBriefingDate(firstParam(params.date));

  if (resolution.shouldCanonicalizeToToday) {
    redirect("/briefing");
  }

  const { effectiveDate, isToday, referenceInstant, notice } = resolution;
  const todayDate = formatBriefingDate(new Date());
  const previousDate = shiftBriefingDate(effectiveDate, -1);
  const nextDate = shiftBriefingDate(effectiveDate, 1);

  // Step 28 §10: current source-health status describes NOW, not the
  // selected historical date — never fetched or rendered for a historical
  // view, so there's no risk of a live status being mistaken for what the
  // corpus's health looked like back then.
  const [pool, health, bookmarkedKeys, readingStateKeys, topicRows] = await Promise.all([
    getFeedItemsForBriefing({ referenceInstant }),
    isToday ? getAllSourceHealth() : Promise.resolve([]),
    getBookmarkedSourceKeys(),
    getReadingStateKeys(),
    getFeedItemsForTopics({ sinceDays: ACTIVE_TOPICS_SINCE_DAYS, referenceInstant }),
  ]);

  const bookmarked = new Set(bookmarkedKeys);
  const queued = new Set(readingStateKeys.queuedKeys);
  const sections = buildBriefing(pool, { now: referenceInstant });
  const freshness = isToday ? summarizeSourceFreshness(health) : null;
  const activeTopics = aggregateTopics(topicRows).slice(0, ACTIVE_TOPICS_LIMIT);

  const hasAnyItems =
    sections.topStories.length > 0 ||
    sections.research.length > 0 ||
    sections.projects.length > 0 ||
    sections.newsAndDiscussion.length > 0;

  const neverRefreshedAtAll = isToday && freshness!.overallLastRefreshedAt === null;

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
        <h1 className="text-2xl font-bold text-slate-900">
          {isToday ? "Briefing" : `Briefing for ${formatDateHeading(effectiveDate)}`}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {isToday
            ? `Highlights from the last ${WINDOW_LABEL} of your persisted AI news stream — selected by recency and source diversity, not AI judgment.`
            : `Reconstructed from persisted data — the last ${WINDOW_LABEL} of evidence leading up to ${formatDateHeading(effectiveDate)}, selected by recency and source diversity.`}
        </p>

        <nav aria-label="Briefing date" className="mt-4 flex flex-wrap items-center gap-2">
          <Link
            href={`/briefing?date=${previousDate}`}
            aria-label="Previous day"
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <ChevronLeft size={15} />
            Previous
          </Link>

          <BriefingDatePicker value={effectiveDate} max={todayDate} />

          {isToday ? (
            <button
              type="button"
              disabled
              aria-label="Next day"
              className="flex cursor-not-allowed items-center gap-1 rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-1.5 text-sm font-medium text-slate-300"
            >
              Next
              <ChevronRight size={15} />
            </button>
          ) : (
            <Link
              href={`/briefing?date=${nextDate}`}
              aria-label="Next day"
              className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Next
              <ChevronRight size={15} />
            </Link>
          )}

          {!isToday && (
            <Link
              href="/briefing"
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              Today
            </Link>
          )}
        </nav>

        {notice && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
            <Info size={14} />
            {notice}
          </div>
        )}

        {/* Freshness / source-health context (Step 22 §7-8) — today only;
            see the module doc comment above for why a historical view
            never renders this. */}
        {isToday && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
            {neverRefreshedAtAll ? (
              <span>Sources have never been refreshed.</span>
            ) : (
              <span>
                Corpus last refreshed {formatRelativeTime(freshness!.overallLastRefreshedAt!.toISOString())}
                {freshness!.isStale ? " — may not reflect the latest." : "."}
                {freshness!.failedSourceLabels.length > 0 &&
                  ` ${freshness!.failedSourceLabels.length} source${freshness!.failedSourceLabels.length === 1 ? "" : "s"} failed last attempt.`}
                {freshness!.neverRefreshedSourceLabels.length > 0 &&
                  ` ${freshness!.neverRefreshedSourceLabels.length} source${freshness!.neverRefreshedSourceLabels.length === 1 ? "" : "s"} never refreshed.`}
              </span>
            )}
            <BriefingRefreshButton compact />
          </div>
        )}

        {neverRefreshedAtAll && !hasAnyItems ? (
          <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            Your briefing will appear once sources are refreshed for the first time.
          </p>
        ) : !hasAnyItems ? (
          <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            {isToday
              ? `No new items in the last ${WINDOW_LABEL}. Try refreshing sources, or check back later.`
              : `No persisted evidence in the ${WINDOW_LABEL} leading up to ${formatDateHeading(effectiveDate)}.`}
          </p>
        ) : (
          <div className="mt-6 flex flex-col gap-8">
            <BriefingSection
              title="Top stories"
              items={sections.topStories}
              bookmarked={bookmarked}
              queued={queued}
              referenceInstant={referenceInstant}
            />
            <BriefingSection
              title="Research"
              subtitle="Recent arXiv papers"
              items={sections.research}
              bookmarked={bookmarked}
              queued={queued}
              referenceInstant={referenceInstant}
            />
            <BriefingSection
              title="Projects"
              subtitle="Recent GitHub repositories"
              items={sections.projects}
              bookmarked={bookmarked}
              queued={queued}
              referenceInstant={referenceInstant}
            />
            <BriefingSection
              title="News & discussion"
              items={sections.newsAndDiscussion}
              bookmarked={bookmarked}
              queued={queued}
              referenceInstant={referenceInstant}
            />
          </div>
        )}

        {activeTopics.length > 0 && (
          <section className="mt-10 border-t border-slate-200 pt-6">
            <h2 className="text-sm font-semibold text-slate-900">Active topics</h2>
            <p className="mt-1 text-xs text-slate-400">
              {isToday
                ? `From the last ${ACTIVE_TOPICS_SINCE_DAYS} days — see Topics for the full picture.`
                : `From the ${ACTIVE_TOPICS_SINCE_DAYS} days leading up to ${formatDateHeading(effectiveDate)}.`}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {activeTopics.map((topic) => (
                <Link
                  key={topic.slug}
                  href={`/topics/${topic.slug}`}
                  className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  {topic.label}
                  <span className="text-slate-400">{topic.totalCount}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

import type { FeedItem, SourceType } from "@/types/feed";
import type { SourceHealthSummary } from "@/db/repository";
import { RSS_SOURCES } from "@/data/rssSources";

/**
 * Step 22 — deterministic, database-only briefing selection. Pure
 * functions only (no DB, no network, no AI/embedding call), mirroring
 * Step 20's `lib/topics.ts` split: `src/db/repository.ts` supplies a
 * single bounded candidate pool, this module decides what belongs in the
 * briefing and where. Same input always produces the same output.
 *
 * Window choice (corpus inspection, see Step 22 final report): with the
 * real corpus at the time of this milestone, a naive 24h window left
 * arXiv ("paper") and RSS ("news") completely EMPTY (0 items each) — this
 * app has no scheduler (Step 21 §0 exclusion), so ingestion runs whenever
 * a human remembers to click Refresh, and upstream publication cadence
 * for slower sources (arXiv, publisher blogs) is itself multi-day. 48h
 * still left "news" at only 3 of 48 items. 72h was the smallest window
 * where every source type had a genuinely usable pool (paper 50, github
 * 20, hackernews 8, news 5) — the smallest defensible default, not an
 * arbitrary one.
 */
export const BRIEFING_WINDOW_HOURS = 72;

export const TOP_STORIES_LIMIT = 6;
/** Caps any single source type's share of Top Stories so e.g. a burst of
 * GitHub trending repos can't crowd out arXiv/HN/news entirely — the
 * "avoid one source dominating" rule from the milestone's own example
 * design. Deliberately NOT applied to Research/Projects/News & Discussion
 * below: each of those sections is already scoped to one (or two closely
 * related) source type(s) by definition, so a within-section diversity
 * cap would have nothing meaningful to diversify against. */
export const MAX_PER_SOURCE_TYPE_IN_TOP_STORIES = 2;
export const RESEARCH_LIMIT = 6;
export const PROJECTS_LIMIT = 6;
export const NEWS_AND_DISCUSSION_LIMIT = 8;
export const ACTIVE_TOPICS_LIMIT = 6;

export interface BriefingSections {
  topStories: FeedItem[];
  research: FeedItem[];
  projects: FeedItem[];
  newsAndDiscussion: FeedItem[];
}

export interface BuildBriefingOptions {
  /** The reference instant the eligibility window is anchored to — both
   * its upper bound and the anchor for its rolling `windowHours` lower
   * bound. Injectable for deterministic tests (and, since Step 28, for
   * historical `/briefing?date=` reconstruction — see `briefingDate.ts`);
   * defaults to the real current time for the live "today" briefing. */
  now?: Date;
  windowHours?: number;
}

/**
 * Step 28: an item is eligible only if it was published within the
 * rolling window AND not after the reference instant itself. Before this,
 * eligibility only checked the lower bound — harmless for the live
 * briefing (nothing has a future `publishedAt`), but load-bearing for a
 * historical date: without the upper bound, reconstructing "the briefing
 * for Sep 20" from today's full corpus would incorrectly include items
 * published on Sep 21+, which is not what Sep 20 legitimately means (Step
 * 28 §2's `cutoffMs < publishedAt <= referenceInstantMs` contract).
 */
function isWithinWindow(item: FeedItem, cutoffMs: number, referenceInstantMs: number): boolean {
  const publishedAtMs = new Date(item.publishedAt).getTime();
  return publishedAtMs > cutoffMs && publishedAtMs <= referenceInstantMs;
}

/**
 * Selects and sections a bounded candidate pool. `pool` need not be
 * pre-filtered or pre-sorted — this applies the exact eligible-window
 * cutoff and ordering itself, which is what makes the window boundary
 * independently testable (inject `now` and a `windowHours` and assert on
 * the exact edge).
 *
 * Selection rules (in order):
 * 1. Eligible pool = items published strictly after `now - windowHours`
 *    AND at or before `now` itself (Step 28: the reference instant is an
 *    upper bound too, not just the anchor for the lower one).
 * 2. Top stories: walk the eligible pool in recency order, adding an item
 *    only if its source type hasn't already hit
 *    `MAX_PER_SOURCE_TYPE_IN_TOP_STORIES`, until `TOP_STORIES_LIMIT` is
 *    reached or the pool is exhausted. Order is primarily recency, with a
 *    per-type cap as the only other factor — no cross-source score.
 * 3. Research/Projects/News & Discussion each draw from the SAME eligible
 *    pool, filtered to their own source type(s), excluding anything
 *    already placed in Top Stories (or an earlier section here) — so no
 *    item ever appears twice — ordered by recency, each capped at its own
 *    limit.
 */
export function buildBriefing(pool: FeedItem[], options: BuildBriefingOptions = {}): BriefingSections {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? BRIEFING_WINDOW_HOURS;
  const nowMs = now.getTime();
  const cutoffMs = nowMs - windowHours * 60 * 60 * 1000;

  const eligible = pool
    .filter((item) => isWithinWindow(item, cutoffMs, nowMs))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const topStories: FeedItem[] = [];
  const perTypeCount = new Map<SourceType, number>();
  for (const item of eligible) {
    if (topStories.length >= TOP_STORIES_LIMIT) break;
    const count = perTypeCount.get(item.sourceType) ?? 0;
    if (count >= MAX_PER_SOURCE_TYPE_IN_TOP_STORIES) continue;
    topStories.push(item);
    perTypeCount.set(item.sourceType, count + 1);
  }

  const used = new Set(topStories.map((item) => item.id));

  function takeSection(matches: (item: FeedItem) => boolean, limit: number): FeedItem[] {
    const section: FeedItem[] = [];
    for (const item of eligible) {
      if (section.length >= limit) break;
      if (used.has(item.id) || !matches(item)) continue;
      section.push(item);
    }
    for (const item of section) used.add(item.id);
    return section;
  }

  const research = takeSection((item) => item.sourceType === "paper", RESEARCH_LIMIT);
  const projects = takeSection((item) => item.sourceType === "github", PROJECTS_LIMIT);
  const newsAndDiscussion = takeSection(
    (item) => item.sourceType === "news" || item.sourceType === "hackernews" || item.sourceType === "discussion",
    NEWS_AND_DISCUSSION_LIMIT
  );

  return { topStories, research, projects, newsAndDiscussion };
}

// --- Source freshness summary --------------------------------------------

/** Every stable source-health identity this app currently refreshes (see
 * Step 21 §5) — kept here (not re-derived from `source_health` rows alone)
 * so a source that has NEVER been attempted, and therefore has no row at
 * all, is still correctly reported as "never refreshed" rather than
 * silently omitted. */
export const ALL_SOURCE_HEALTH_KEYS: string[] = [
  "hackernews",
  "arxiv",
  "github",
  ...RSS_SOURCES.map((source) => `rss:${source.id}`),
];

/** Matches Sidebar.tsx's Step 21 freshness threshold — duplicated rather
 * than imported because that file is a "use client" UI component (would
 * pull React/lucide-react into this dependency-free, Node-testable
 * module) and because a single well-justified 6-hour constant is cheaper
 * to keep in sync by comment than to refactor an already-shipped
 * component's export surface for. */
export const BRIEFING_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export interface SourceFreshnessSummary {
  /** Most recent `lastSucceededAt` across every configured source, or
   * `null` if none has ever succeeded. */
  overallLastRefreshedAt: Date | null;
  /** True if the corpus has never been refreshed at all, OR its most
   * recent success is older than `BRIEFING_STALE_THRESHOLD_MS` — the
   * signal the UI uses to say "this may not reflect the latest" instead
   * of implying the absence of new items means an actually quiet day. */
  isStale: boolean;
  failedSourceLabels: string[];
  neverRefreshedSourceLabels: string[];
}

/**
 * Pure summary over already-fetched health rows — no DB call itself. Kept
 * separate from `getAllSourceHealth` (which only returns rows that exist)
 * so a source with NO row at all is still classified correctly.
 */
export function summarizeSourceFreshness(
  health: SourceHealthSummary[],
  now: Date = new Date(),
  configuredSourceKeys: string[] = ALL_SOURCE_HEALTH_KEYS
): SourceFreshnessSummary {
  const byKey = new Map(health.map((row) => [row.sourceKey, row]));
  const failedSourceLabels: string[] = [];
  const neverRefreshedSourceLabels: string[] = [];
  let overallLastRefreshedAt: Date | null = null;

  for (const key of configuredSourceKeys) {
    const row = byKey.get(key);
    if (!row || row.lastStatus === "never_run") {
      neverRefreshedSourceLabels.push(row?.sourceLabel ?? key);
      continue;
    }
    if (row.lastStatus === "failed") failedSourceLabels.push(row.sourceLabel);
    if (row.lastSucceededAt && (!overallLastRefreshedAt || row.lastSucceededAt > overallLastRefreshedAt)) {
      overallLastRefreshedAt = row.lastSucceededAt;
    }
  }

  const isStale =
    overallLastRefreshedAt === null || now.getTime() - overallLastRefreshedAt.getTime() > BRIEFING_STALE_THRESHOLD_MS;

  return { overallLastRefreshedAt, isStale, failedSourceLabels, neverRefreshedSourceLabels };
}

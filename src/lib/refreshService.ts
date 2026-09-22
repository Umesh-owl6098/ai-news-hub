import "server-only";
import { getAiHackerNewsFeedItems } from "@/lib/sources/hackernews";
import { getArxivAiFeedItems } from "@/lib/sources/arxiv";
import { getGithubAiFeedItems, GithubRateLimitError } from "@/lib/sources/github";
import { getRssFeedItems, type RssFeedResult } from "@/lib/sources/rss";
import { RSS_SOURCES } from "@/data/rssSources";
import {
  upsertFeedItems,
  recordSourceHealthAttempt,
  recordSourceHealthSuccess,
  recordSourceHealthFailure,
  DatabaseError,
} from "@/db/repository";
import type { FeedItem } from "@/types/feed";
import type { SourceHealthErrorCategory } from "@/db/schema";

/**
 * Step 21 — the ONE explicit refresh operation for every currently
 * supported source. Never called from page rendering (see `page.tsx`,
 * which now only reads persisted data) — only from the "Refresh sources"
 * server action and the `sources:refresh` CLI script, both of which call
 * `refreshAllSources` directly so there is exactly one implementation of
 * "what a refresh does," never a UI copy and a CLI copy.
 */

// Bounds how long this operation WAITS for a single source's fetch, not a
// true fetch cancellation — none of the four adapters accept an
// AbortSignal today (confirmed by inspection), and adding one to each
// would be a larger, more invasive change than this milestone's "preserve
// existing... unless it conflicts with explicit refresh semantics"
// allows. An abandoned fetch may still complete in the background
// (harmless — its result is simply never awaited), but the refresh
// operation itself is guaranteed to move on and report a timeout rather
// than hang indefinitely, which is what "isolate failures" requires here.
const SOURCE_TIMEOUT_MS = 20_000;

export class RefreshTimeoutError extends Error {
  constructor(ms: number, label: string) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "RefreshTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RefreshTimeoutError(ms, label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Defense in depth only — every message the four source adapters actually
// throw today is already a hand-written safe string (confirmed by
// inspection: none of them interpolate a raw response body, header, or
// token). This exists so a future adapter change can't accidentally leak
// something through this path unnoticed.
//
// Truncates at the FIRST secret-looking keyword rather than trying to
// match just the value after it (e.g. "Bearer <token>" is two words —
// a value-only pattern like `bearer\s+\S+` would redact "Bearer" but
// leave the actual token sitting right after it). Cutting the whole rest
// of the message is the only shape of this check that can't leak a
// secret it fails to precisely bound.
const SECRET_KEYWORD_PATTERN = /\b(bearer|authorization|api[_-]?key|token)\b/i;
const MAX_SANITIZED_MESSAGE_LENGTH = 300;

function sanitizeErrorMessage(message: string): string {
  const match = message.match(SECRET_KEYWORD_PATTERN);
  const safe = match && match.index !== undefined ? `${message.slice(0, match.index).trimEnd()} [redacted]` : message;
  return safe.slice(0, MAX_SANITIZED_MESSAGE_LENGTH);
}

/**
 * Maps a caught error to a small, bounded category (matching
 * `SOURCE_HEALTH_ERROR_CATEGORIES` in schema.ts) plus a sanitized,
 * display-safe message. Only `GithubRateLimitError`/`RefreshTimeoutError`/
 * `DatabaseError` are structurally distinguishable today (confirmed by
 * inspection — the adapters have no other typed errors); everything else
 * falls back to a light heuristic over the adapters' own already-safe
 * message text, then "unknown" — never an attempt to parse a raw
 * response body, which none of these messages contain anyway.
 */
export function categorizeError(error: unknown): { category: SourceHealthErrorCategory; message: string } {
  if (error instanceof GithubRateLimitError) {
    return { category: "rate_limited", message: sanitizeErrorMessage(error.message) };
  }
  if (error instanceof RefreshTimeoutError) {
    return { category: "timeout", message: sanitizeErrorMessage(error.message) };
  }
  if (error instanceof DatabaseError) {
    return { category: "database_error", message: sanitizeErrorMessage(error.message) };
  }
  if (error instanceof Error) {
    const message = sanitizeErrorMessage(error.message);
    if (/network error/i.test(message)) return { category: "network_error", message };
    if (/request failed \(\d+\)|returned \(\d+\)|error \(\d+\)/i.test(message)) return { category: "http_error", message };
    if (/malformed|unrecognized feed|parse|parsing/i.test(message)) return { category: "parse_error", message };
    return { category: "unknown", message };
  }
  return { category: "unknown", message: "An unexpected error occurred." };
}

export interface SourceRefreshOutcome {
  sourceKey: string;
  sourceLabel: string;
  status: "success" | "failed";
  itemCount?: number;
  errorCategory?: SourceHealthErrorCategory;
  errorMessage?: string;
}

export interface RefreshSummary {
  startedAt: string;
  finishedAt: string;
  outcomes: SourceRefreshOutcome[];
}

/** Injectable so tests can exercise the full refresh flow (health
 * recording, upsert, failure isolation) against controlled fake fetchers
 * — zero real network calls, zero real DB contamination risk beyond what
 * the test itself seeds. Production always uses the real adapters. */
export interface SourceFetchers {
  fetchHackerNews: () => Promise<FeedItem[]>;
  fetchArxiv: () => Promise<FeedItem[]>;
  fetchGithub: () => Promise<FeedItem[]>;
  fetchRss: () => Promise<RssFeedResult>;
}

const DEFAULT_FETCHERS: SourceFetchers = {
  fetchHackerNews: () => getAiHackerNewsFeedItems(),
  fetchArxiv: () => getArxivAiFeedItems(),
  fetchGithub: () => getGithubAiFeedItems(),
  fetchRss: () => getRssFeedItems(),
};

async function refreshSimpleSource(
  sourceKey: string,
  sourceLabel: string,
  fetchLive: () => Promise<FeedItem[]>
): Promise<SourceRefreshOutcome> {
  await recordSourceHealthAttempt(sourceKey, sourceLabel);
  try {
    const items = await withTimeout(fetchLive(), SOURCE_TIMEOUT_MS, sourceLabel);
    await upsertFeedItems(items);
    await recordSourceHealthSuccess(sourceKey, sourceLabel, items.length);
    return { sourceKey, sourceLabel, status: "success", itemCount: items.length };
  } catch (error) {
    const { category, message } = categorizeError(error);
    await recordSourceHealthFailure(sourceKey, sourceLabel, category, message);
    return { sourceKey, sourceLabel, status: "failed", errorCategory: category, errorMessage: message };
  }
}

function rssHealthIdentity(source: (typeof RSS_SOURCES)[number]): { sourceKey: string; sourceLabel: string } {
  return { sourceKey: `rss:${source.id}`, sourceLabel: `${source.name} RSS` };
}

/**
 * RSS gets its own function, not `refreshSimpleSource`, because it must
 * produce ONE health row per configured publisher (Step 21 §5: never
 * collapse all RSS feeds into one row) even though `getRssFeedItems`
 * fetches and upserts all of them together in one call — exactly
 * mirroring the existing `ingestRssSource`'s already-correct
 * per-publisher isolation (`Promise.allSettled` inside `getRssFeedItems`
 * itself), just deriving per-publisher health from its result shape
 * instead of restructuring `rss.ts`.
 */
async function refreshRssSources(fetchRss: () => Promise<RssFeedResult>): Promise<SourceRefreshOutcome[]> {
  await Promise.all(RSS_SOURCES.map((source) => {
    const { sourceKey, sourceLabel } = rssHealthIdentity(source);
    return recordSourceHealthAttempt(sourceKey, sourceLabel);
  }));

  let result: RssFeedResult;
  try {
    result = await withTimeout(fetchRss(), SOURCE_TIMEOUT_MS, "RSS feeds");
  } catch (error) {
    // The RSS layer itself never throws for a per-publisher failure
    // (confirmed by inspection — it's Promise.allSettled internally); a
    // throw here means either our own timeout fired or something
    // structural broke before per-publisher isolation could even run.
    const { category, message } = categorizeError(error);
    return Promise.all(
      RSS_SOURCES.map(async (source) => {
        const { sourceKey, sourceLabel } = rssHealthIdentity(source);
        await recordSourceHealthFailure(sourceKey, sourceLabel, category, message);
        return { sourceKey, sourceLabel, status: "failed" as const, errorCategory: category, errorMessage: message };
      })
    );
  }

  if (result.items.length > 0) {
    try {
      await upsertFeedItems(result.items);
    } catch (error) {
      // The fetch succeeded but the single bulk upsert for all RSS items
      // failed atomically — nothing from this refresh was persisted, so
      // every publisher that actually had items to write is honestly
      // "failed" at the database layer. A publisher that already failed
      // at fetch time keeps its own (more specific) fetch-failure reason.
      const { category, message } = categorizeError(error);
      return Promise.all(
        RSS_SOURCES.map(async (source) => {
          const { sourceKey, sourceLabel } = rssHealthIdentity(source);
          if (result.failedSourceNames.includes(source.name)) {
            const fetchMessage = "Feed fetch failed.";
            await recordSourceHealthFailure(sourceKey, sourceLabel, "network_error", fetchMessage);
            return { sourceKey, sourceLabel, status: "failed" as const, errorCategory: "network_error" as const, errorMessage: fetchMessage };
          }
          await recordSourceHealthFailure(sourceKey, sourceLabel, category, message);
          return { sourceKey, sourceLabel, status: "failed" as const, errorCategory: category, errorMessage: message };
        })
      );
    }
  }

  return Promise.all(
    RSS_SOURCES.map(async (source) => {
      const { sourceKey, sourceLabel } = rssHealthIdentity(source);
      if (result.failedSourceNames.includes(source.name)) {
        const message = "Feed fetch failed.";
        await recordSourceHealthFailure(sourceKey, sourceLabel, "network_error", message);
        return { sourceKey, sourceLabel, status: "failed" as const, errorCategory: "network_error" as const, errorMessage: message };
      }
      const itemCount = result.items.filter((item) => item.sourceId === source.id).length;
      await recordSourceHealthSuccess(sourceKey, sourceLabel, itemCount);
      return { sourceKey, sourceLabel, status: "success" as const, itemCount };
    })
  );
}

// Process-local, in-memory only — deliberately not a database/Redis lock.
// Sufficient for this app's actual deployment model (a single local Node
// process serves every request; see the Step 21 final report for why a
// cross-process lock isn't needed here). Two overlapping calls (e.g. two
// browser tabs clicking "Refresh" close together) both receive the SAME
// in-flight result rather than running a duplicate refresh concurrently.
// After a process restart, this resets to `null` automatically — there is
// no stale "stuck" state to clean up, unlike a persisted lock that could
// survive a crash.
let inFlightRefresh: Promise<RefreshSummary> | null = null;

export function isRefreshInFlight(): boolean {
  return inFlightRefresh !== null;
}

export async function refreshAllSources(fetchers: SourceFetchers = DEFAULT_FETCHERS): Promise<RefreshSummary> {
  if (inFlightRefresh) return inFlightRefresh;

  const run = (async (): Promise<RefreshSummary> => {
    const startedAt = new Date().toISOString();
    const [hn, arxiv, github, rss] = await Promise.all([
      refreshSimpleSource("hackernews", "Hacker News", fetchers.fetchHackerNews),
      refreshSimpleSource("arxiv", "arXiv", fetchers.fetchArxiv),
      refreshSimpleSource("github", "GitHub", fetchers.fetchGithub),
      refreshRssSources(fetchers.fetchRss),
    ]);
    return { startedAt, finishedAt: new Date().toISOString(), outcomes: [hn, arxiv, github, ...rss] };
  })();

  inFlightRefresh = run;
  try {
    return await run;
  } finally {
    inFlightRefresh = null;
  }
}

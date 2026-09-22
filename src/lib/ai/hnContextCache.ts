import "server-only";
import { getHnContextCache, upsertHnContextCache, type HnContextCacheRecord } from "@/db/repository";
import { fetchHnDiscussionContext } from "@/lib/ai/hnContext";

/**
 * Production integration of the Step 13 input-augmentation experiment:
 * caches the bounded HN discussion context per feed item so enrichment
 * doesn't refetch comments on every run, with graceful degradation when
 * Hacker News is unreachable. This is the ONLY place that decides
 * freshness/staleness — that policy deliberately lives here, not in the
 * database schema (see schema.ts) or in the input hash (see hash.ts,
 * which only ever sees `normalizedContext`, never a timestamp).
 */
export const HN_CONTEXT_LABEL = "Hacker News discussion context";

// Exported so observability (ai:status) and the resolution logic below
// agree on exactly one definition of "fresh" — never redefined elsewhere.
export const HN_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SourceContext {
  label: string;
  text: string;
}

function parseHnStoryId(sourceKey: string): number | null {
  if (!sourceKey.startsWith("hn:")) return null;
  const id = Number.parseInt(sourceKey.slice("hn:".length), 10);
  return Number.isFinite(id) ? id : null;
}

export function isHnSourceKey(sourceKey: string): boolean {
  return parseHnStoryId(sourceKey) !== null;
}

function isFreshCacheRow(cached: HnContextCacheRecord, now: number): boolean {
  return now - cached.fetchedAt.getTime() < HN_CONTEXT_TTL_MS;
}

/**
 * Read-only: never calls the Hacker News API, never writes to the cache.
 * For the dry-run preview and the batch eligibility pre-filter, both of
 * which must reflect the CURRENT cached state without side effects —
 * whether that cache is fresh or stale is irrelevant here, since neither
 * caller is about to trigger a real refresh. A `no_context` row (a
 * confirmed "nothing usable") yields `undefined` here exactly like a
 * missing row, since either way there's no text to add to the prompt.
 */
export async function peekCachedHnContext(feedItemId: number, sourceKey: string): Promise<SourceContext | undefined> {
  if (!isHnSourceKey(sourceKey)) return undefined;
  const cached = await getHnContextCache(feedItemId);
  return cached?.status === "has_context" ? { label: HN_CONTEXT_LABEL, text: cached.normalizedContext } : undefined;
}

/**
 * Full resolution used by real enrichment (`enrichFeedItem`):
 *
 *  - non-HN item                        -> undefined, zero DB/network work
 *  - fresh 'has_context' cache          -> reuse it, ZERO Hacker News API calls
 *  - fresh 'no_context' cache           -> undefined, ZERO Hacker News API calls
 *  - stale or missing cache             -> attempt one live refresh
 *      - refresh finds usable content   -> persist 'has_context', use it
 *      - refresh confirms nothing usable-> persist 'no_context', return undefined
 *      - refresh fails (HN outage)      -> persist NOTHING, fall back to
 *                                           whatever was already cached
 *                                           (any status), else undefined
 *
 * This is the ONLY place that decides whether to spend a live Hacker News
 * call — it never decides whether to spend a model call. That second,
 * more expensive decision is made one level up in `enrichFeedItem`, purely
 * from comparing input hashes, and this function's return value is simply
 * one input to that hash. A stale-but-content-unchanged refresh here
 * therefore costs Hacker News requests but zero OpenAI calls.
 *
 * Never throws — a Hacker News problem must never fail the enrichment
 * itself; it just means less context than ideal, which is exactly what
 * "AI enrichment stays optional" already means one level up.
 */
export async function resolveHnSourceContext(sourceKey: string, feedItemId: number): Promise<SourceContext | undefined> {
  const storyId = parseHnStoryId(sourceKey);
  if (storyId === null) return undefined;

  const cached = await getHnContextCache(feedItemId);
  if (cached && isFreshCacheRow(cached, Date.now())) {
    return cached.status === "has_context" ? { label: HN_CONTEXT_LABEL, text: cached.normalizedContext } : undefined;
  }

  try {
    const fresh = await fetchHnDiscussionContext(storyId);
    if (fresh) {
      await upsertHnContextCache(feedItemId, { status: "has_context", normalizedContext: fresh.text });
      // Always the canonical label, never `fresh.label` verbatim: the cache
      // only ever stores `normalizedContext`, so every OTHER return path
      // (fresh-cache reuse, stale-cache/outage fallback) necessarily uses
      // `HN_CONTEXT_LABEL`. Using `fresh.label` here too would make the
      // resulting sourceContext — and therefore the input hash — depend on
      // which code path served it, not just on the content, for a field
      // that's supposed to be a stable label rather than real content.
      return { label: HN_CONTEXT_LABEL, text: fresh.text };
    }
    // A confirmed, successful "nothing usable" — persist it as such so a
    // future run within the TTL doesn't re-fetch to learn the same thing,
    // while still allowing a re-check once the TTL passes (comments can
    // appear on a story after the fact).
    await upsertHnContextCache(feedItemId, { status: "no_context" });
    return undefined;
  } catch (error) {
    console.error(`[ai:hnContext] live refresh failed for ${sourceKey}, falling back to cache if any:`, error);
  }

  // The live fetch failed outright (HN outage) — never persist anything
  // for this outcome (see hnContext.ts's throw contract): graceful
  // degradation means falling back to whatever was already cached,
  // regardless of its status, or no augmentation at all if there was none.
  if (!cached) return undefined;
  return cached.status === "has_context" ? { label: HN_CONTEXT_LABEL, text: cached.normalizedContext } : undefined;
}

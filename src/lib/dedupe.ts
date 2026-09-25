import { FeedItem, SourceType } from "@/types/feed";
import { canonicalizeUrl } from "@/lib/url";
import { normalizeTitle } from "@/lib/title";

// Lower number = kept when the same story appears from multiple sources
// (e.g. an original publisher RSS post and an HN link to it). Explicit and
// simple on purpose — this is not a ranking algorithm.
const SOURCE_PRIORITY: Record<SourceType, number> = {
  news: 0,
  paper: 1,
  github: 1,
  hackernews: 2,
  discussion: 3,
};

function sourcePriority(item: FeedItem): number {
  return SOURCE_PRIORITY[item.sourceType] ?? 99;
}

/**
 * Lightweight in-memory dedup for the combined "All" feed only — dedicated
 * per-source tabs (e.g. Hacker News) are never filtered by this. Matches on
 * canonical URL first, then normalized title as a secondary signal. When
 * two items collide, the one from the higher-priority source wins (ties:
 * the earlier item in the input).
 *
 * Source priority decides only WHICH duplicate survives — it never
 * reorders the result. Survivors come back in the caller's input order, so
 * a search ranking (Relevance, Newest) supplied by SQL is left intact. The
 * previous implementation returned survivors in priority order, which
 * silently regrouped "All" search results by source.
 */
export function dedupeFeedItems(items: FeedItem[]): FeedItem[] {
  // Decide winners by walking the items in priority order (input position
  // breaks ties, so the outcome is deterministic)...
  const byPriority = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => sourcePriority(a.item) - sourcePriority(b.item) || a.index - b.index);

  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const keptIndexes = new Set<number>();

  for (const { item, index } of byPriority) {
    const urlKey = canonicalizeUrl(item.url);
    const titleKey = normalizeTitle(item.title);

    if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) continue;

    seenUrls.add(urlKey);
    seenTitles.add(titleKey);
    keptIndexes.add(index);
  }

  // ...then emit the winners in the caller's original order.
  return items.filter((_, index) => keptIndexes.has(index));
}

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
 * two items collide, the one from the higher-priority source wins.
 */
export function dedupeFeedItems(items: FeedItem[]): FeedItem[] {
  const sorted = [...items].sort((a, b) => sourcePriority(a) - sourcePriority(b));

  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const result: FeedItem[] = [];

  for (const item of sorted) {
    const urlKey = canonicalizeUrl(item.url);
    const titleKey = normalizeTitle(item.title);

    if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) continue;

    seenUrls.add(urlKey);
    seenTitles.add(titleKey);
    result.push(item);
  }

  return result;
}

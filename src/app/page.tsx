import { DashboardClient } from "@/components/DashboardClient";
import { mockFeedItems } from "@/data/mockFeed";
import { RSS_SOURCES } from "@/data/rssSources";
import {
  getBookmarkedSourceKeys,
  getBookmarkedFeedItems,
  getEnrichmentsBySourceKeys,
  getRecentFeedItems,
  getAllSourceHealth,
  getReadingStateKeys,
  getUnreadQueuedCount,
  DatabaseError,
  type SourceHealthSummary,
} from "@/db/repository";
import { parseSearchState, isSearchActive } from "@/lib/searchState";
import { performSearch } from "@/lib/search";
import { getEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import { FeedItem, SourceType } from "@/types/feed";

// Recent-item bounds per source — unchanged from when these limits also
// bounded each live fetch (Step 21 removed the live fetch, not the limit).
const HN_LIMIT = 20;
const ARXIV_LIMIT = 25;
const GITHUB_LIMIT = 25;
const NEWS_LIMIT = 40;

interface PersistedSourceResult {
  items: FeedItem[];
  error: string | null;
  notice: string | null;
}

/**
 * Step 21: reads ONLY persisted data — no external network call, ever.
 * Refreshing from the live sources now happens exclusively through the
 * explicit "Refresh sources" action (`src/app/actions/refresh.ts`) or the
 * `sources:refresh` CLI, both backed by `refreshAllSources`
 * (`src/lib/refreshService.ts`). If the DB has never been refreshed for
 * this source at all (every relevant `source_health` row is missing or
 * `never_run`), the empty result gets an explicit bootstrap notice
 * instead of silently looking like "no AI news exists" — the one
 * concession to a useful first-run experience that stops short of
 * fetching anything.
 */
async function readPersistedSource(
  sourceType: SourceType,
  limit: number,
  relevantHealthKeys: string[],
  healthByKey: Map<string, SourceHealthSummary>
): Promise<PersistedSourceResult> {
  try {
    const items = await getRecentFeedItems({ sourceType, limit });
    if (items.length === 0) {
      const everNeverRun = relevantHealthKeys.every((key) => (healthByKey.get(key)?.lastStatus ?? "never_run") === "never_run");
      if (everNeverRun) {
        return { items, error: null, notice: 'No items yet — use "Refresh sources" in the sidebar to fetch the latest.' };
      }
    }
    return { items, error: null, notice: null };
  } catch (error) {
    if (error instanceof DatabaseError) return { items: [], error: error.message, notice: null };
    throw error;
  }
}

interface BookmarksReadResult {
  keys: string[];
  items: FeedItem[];
  error: string | null;
}

/** Bookmark reads are read-only and isolated like every other source: a
 * bookmarks-table failure must not take down the feeds or throw past here. */
async function readBookmarks(): Promise<BookmarksReadResult> {
  try {
    const [keys, items] = await Promise.all([getBookmarkedSourceKeys(), getBookmarkedFeedItems()]);
    return { keys, items, error: null };
  } catch {
    return { keys: [], items: [], error: "Couldn't load bookmarks right now." };
  }
}

const PUBLISHER_OPTIONS = RSS_SOURCES.map((source) => ({ id: source.id, name: source.name }));
const RSS_HEALTH_KEYS = RSS_SOURCES.map((source) => `rss:${source.id}`);

export default async function Home({ searchParams }: PageProps<"/">) {
  const rawParams = await searchParams;
  const searchState = parseSearchState(rawParams);
  const searching = isSearchActive(searchState);

  // Fetched first (one cheap, small query) because the persisted-source
  // reads below use it to decide the "never refreshed yet" bootstrap
  // notice. Step 21: this is the only place page rendering touches
  // anything ingestion-related — reads only, never a live source-network
  // call and never a write. Refreshing happens exclusively through the
  // explicit action/CLI (see refreshService.ts).
  const sourceHealth = await getAllSourceHealth();
  const healthByKey = new Map(sourceHealth.map((h) => [h.sourceKey, h]));

  // Each source reads its own persisted slice independently and in
  // parallel — a failure in one (database, or the search query itself)
  // must never prevent the others from rendering. Search never touches
  // HN/arXiv/GitHub/RSS directly either — it only queries the
  // already-persisted table (see lib/search.ts).
  const [hn, arxiv, github, news, bookmarksResult, searchResult, readingStateKeys, unreadQueuedCount] =
    await Promise.all([
      readPersistedSource("hackernews", HN_LIMIT, ["hackernews"], healthByKey),
      readPersistedSource("paper", ARXIV_LIMIT, ["arxiv"], healthByKey),
      readPersistedSource("github", GITHUB_LIMIT, ["github"], healthByKey),
      readPersistedSource("news", NEWS_LIMIT, RSS_HEALTH_KEYS, healthByKey),
      readBookmarks(),
      searching
        ? performSearch(searchState)
        : Promise.resolve({
            items: [] as FeedItem[],
            total: 0,
            error: null as string | null,
            requestedMode: searchState.mode,
            effectiveMode: searchState.mode,
          }),
      // Step 26: read-only, same isolation discipline as readBookmarks —
      // never allowed to take down the rest of the page.
      getReadingStateKeys().catch(() => ({ queuedKeys: [] as string[], readKeys: [] as string[] })),
      getUnreadQueuedCount().catch(() => 0),
    ]);

  // Presence-only check (no key/model values ever logged or rendered) —
  // determines whether Semantic is offerable BEFORE a search runs, so the
  // UI can present an understandable disabled state instead of a control
  // that silently does nothing (Step 18 §3).
  const semanticAvailable = getEmbeddingProvider() !== null;

  // Ordinary DB read, not an AI call: a bulk lookup of whatever enrichment
  // rows already exist for exactly the items this render fetched. Zero
  // model calls happen during page rendering — enrichment only ever runs
  // out-of-band via the batch CLI (see lib/ai/enrichmentService.ts).
  const allFetchedItems = [
    ...mockFeedItems,
    ...hn.items,
    ...arxiv.items,
    ...github.items,
    ...news.items,
    ...bookmarksResult.items,
    ...searchResult.items,
  ];
  const sourceKeys = Array.from(new Set(allFetchedItems.map((item) => item.id)));
  const enrichmentMap = await getEnrichmentsBySourceKeys(sourceKeys);
  const enrichments = Object.fromEntries(enrichmentMap);

  return (
    <DashboardClient
      mockItems={mockFeedItems}
      hnItems={hn.items}
      hnError={hn.error}
      hnNotice={hn.notice}
      arxivItems={arxiv.items}
      arxivError={arxiv.error}
      arxivNotice={arxiv.notice}
      githubItems={github.items}
      githubError={github.error}
      githubNotice={github.notice}
      newsItems={news.items}
      newsError={news.error}
      newsNotice={news.notice}
      initialBookmarkedKeys={bookmarksResult.keys}
      initialBookmarkedItems={bookmarksResult.items}
      bookmarksError={bookmarksResult.error}
      initialQueuedKeys={readingStateKeys.queuedKeys}
      unreadQueuedCount={unreadQueuedCount}
      searchState={searchState}
      publisherOptions={PUBLISHER_OPTIONS}
      searchItems={searchResult.items}
      searchTotal={searchResult.total}
      searchError={searchResult.error}
      searchRequestedMode={searchResult.requestedMode}
      searchEffectiveMode={searchResult.effectiveMode}
      semanticAvailable={semanticAvailable}
      enrichments={enrichments}
      sourceHealth={sourceHealth}
    />
  );
}

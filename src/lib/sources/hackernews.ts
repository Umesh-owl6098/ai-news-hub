import { HackerNewsItem } from "@/types/hackernews";
import { FeedItem } from "@/types/feed";
import { isAiRelatedTitle } from "@/lib/ai-keywords";
import { htmlToPlainText } from "@/lib/html";

const HN_BASE_URL = "https://hacker-news.firebaseio.com/v0";

// Hacker News changes often, but not so often that a fresh fetch is needed
// on every request.
const REVALIDATE_SECONDS = 300;

// How many of the top story IDs to inspect before filtering. Kept small and
// bounded so we never fan out to hundreds of individual item requests.
const DEFAULT_IDS_TO_INSPECT = 40;

// Upper bound on how many normalized stories we ever return.
const DEFAULT_MAX_STORIES = 20;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { next: { revalidate: REVALIDATE_SECONDS } });
  if (!res.ok) {
    throw new Error(`Hacker News request failed (${res.status}): ${url}`);
  }
  return (await res.json()) as T;
}

export async function getTopStoryIds(): Promise<number[]> {
  return fetchJson<number[]>(`${HN_BASE_URL}/topstories.json`);
}

export async function getNewStoryIds(): Promise<number[]> {
  return fetchJson<number[]>(`${HN_BASE_URL}/newstories.json`);
}

export async function getBestStoryIds(): Promise<number[]> {
  return fetchJson<number[]>(`${HN_BASE_URL}/beststories.json`);
}

export async function getHackerNewsItem(id: number): Promise<HackerNewsItem | null> {
  try {
    return await fetchJson<HackerNewsItem | null>(`${HN_BASE_URL}/item/${id}.json`);
  } catch {
    // A single bad item shouldn't take down the whole feed.
    return null;
  }
}

function isUsableStory(item: HackerNewsItem | null): item is HackerNewsItem {
  if (!item) return false;
  if (item.deleted || item.dead) return false;
  if (item.type !== "story") return false;
  if (!item.title) return false;
  return true;
}

/**
 * Fetches top story IDs, inspects a bounded subset of them, and returns only
 * the usable (non-deleted/dead, story-type, titled) items.
 */
export async function getHackerNewsStories(
  idsToInspect: number = DEFAULT_IDS_TO_INSPECT
): Promise<HackerNewsItem[]> {
  const ids = await getTopStoryIds();
  const candidateIds = ids.slice(0, idsToInspect);

  const items = await Promise.all(candidateIds.map((id) => getHackerNewsItem(id)));

  return items.filter(isUsableStory);
}

/**
 * Converts a raw Hacker News API item into the app's normalized FeedItem
 * shape. The UI never touches HackerNewsItem directly.
 */
export function hackerNewsItemToFeedItem(item: HackerNewsItem): FeedItem {
  const discussionUrl = `https://news.ycombinator.com/item?id=${item.id}`;

  return {
    // Source-prefixed so IDs can never collide with other sources (e.g. arxiv:2401.12345).
    id: `hn:${item.id}`,
    sourceType: "hackernews",
    sourceName: item.by ? `Hacker News · ${item.by}` : "Hacker News",
    title: item.title ?? "Untitled Hacker News story",
    description: item.text ? htmlToPlainText(item.text) : "Discussion thread on Hacker News.",
    publishedAt: item.time ? new Date(item.time * 1000).toISOString() : new Date().toISOString(),
    tags: ["Hacker News"],
    score: item.score ?? 0,
    commentCount: item.descendants ?? 0,
    // Fall back to the HN discussion page when a story has no external link.
    url: item.url ?? discussionUrl,
    // Always available, even when an external article URL also exists.
    discussionUrl,
  };
}

export interface GetHackerNewsFeedOptions {
  idsToInspect?: number;
  maxStories?: number;
}

/**
 * High-level entry point for the dashboard: fetches a bounded set of top
 * stories, filters to AI-related titles, and returns normalized FeedItems.
 */
export async function getAiHackerNewsFeedItems(
  options: GetHackerNewsFeedOptions = {}
): Promise<FeedItem[]> {
  const { idsToInspect = DEFAULT_IDS_TO_INSPECT, maxStories = DEFAULT_MAX_STORIES } = options;

  const stories = await getHackerNewsStories(idsToInspect);
  const aiStories = stories.filter((story) => isAiRelatedTitle(story.title ?? ""));

  return aiStories.slice(0, maxStories).map(hackerNewsItemToFeedItem);
}

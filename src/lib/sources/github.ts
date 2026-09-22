import { GithubErrorResponse, GithubRepository, GithubSearchResponse } from "@/types/github";
import { FeedItem, MAX_FEED_ITEM_TAGS } from "@/types/feed";
import { isAiRelatedTitle } from "@/lib/ai-keywords";

const GITHUB_SEARCH_URL = "https://api.github.com/search/repositories";

// Repository search results don't need to be second-fresh, and search is
// GitHub's most rate-limited endpoint — cache aggressively.
const REVALIDATE_SECONDS = 1800;

// Single page, single request per refresh.
const DEFAULT_PER_PAGE = 25;

// GitHub's search qualifiers (topic:, language:, etc.) cannot be OR'd —
// only free-text terms can ("Logical operators only apply to text, not to
// qualifiers", confirmed against the live API). GitHub also rejects a query
// with more than 5 AND/OR/NOT operators, so this is capped at 6 terms.
// `in:name,description,topics` scopes the OR'd text search to those three
// fields (rather than full-text/README search), which keeps it reasonably
// precise despite not using topic: qualifiers directly.
const GITHUB_SEARCH_TERMS = [
  "llm",
  "artificial intelligence",
  "machine learning",
  "generative ai",
  "agents",
  "rag",
];
const GITHUB_SEARCH_FIELDS = "name,description,topics";

// A few of the requested concepts (diffusion, computer vision, transformer)
// don't fit under the 6-term/5-operator cap above; used only for the local
// relevance filter below, not the API query itself.
const AI_TOPIC_HINTS = [
  "llm",
  "large-language-models",
  "artificial-intelligence",
  "machine-learning",
  "generative-ai",
  "agents",
  "rag",
  "diffusion-models",
  "computer-vision",
  "transformer",
];

// Keeps very old, no-longer-active giant repositories from permanently
// dominating a "news/discovery" feed sorted by stars.
const RECENT_PUSH_WINDOW_DAYS = 180;

const GITHUB_SORT = "stars";
const GITHUB_ORDER = "desc";

export class GithubRateLimitError extends Error {
  constructor(message = "GitHub rate limit reached.") {
    super(message);
    this.name = "GithubRateLimitError";
  }
}

function getRecentPushDateQualifier(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, as GitHub's date qualifiers expect.
}

/**
 * One deliberately-tunable query: AI-relevant terms OR'd together (matched
 * against name/description/topics), scoped to repositories pushed within
 * the last RECENT_PUSH_WINDOW_DAYS days, with archived repos and forks
 * excluded.
 */
export function buildGithubSearchQuery(): string {
  const termClause = GITHUB_SEARCH_TERMS.map((term) => (term.includes(" ") ? `"${term}"` : term)).join(" OR ");
  const pushedSince = getRecentPushDateQualifier(RECENT_PUSH_WINDOW_DAYS);
  return `(${termClause}) in:${GITHUB_SEARCH_FIELDS} pushed:>=${pushedSince} archived:false fork:false`;
}

function logRateLimitInfo(res: Response): void {
  // Server-only, development-time visibility — never sent to the client.
  if (process.env.NODE_ENV === "production") return;
  const limit = res.headers.get("x-ratelimit-limit");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (!limit && !remaining) return;
  const resetLabel = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
  console.log(`[github] rate limit: ${remaining}/${limit} (resets ${resetLabel})`);
}

function isGithubErrorResponse(value: unknown): value is GithubErrorResponse {
  return typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string";
}

async function fetchGithubSearch(query: string, perPage: number): Promise<GithubSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    sort: GITHUB_SORT,
    order: GITHUB_ORDER,
    per_page: String(perPage),
  });

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Optional: only ever read server-side, only ever sent to GitHub's API,
  // never forwarded to the client.
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${GITHUB_SEARCH_URL}?${params.toString()}`, {
      headers,
      next: { revalidate: REVALIDATE_SECONDS },
    });
  } catch {
    throw new Error("GitHub search request failed (network error)");
  }

  logRateLimitInfo(res);

  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if ((res.status === 403 || res.status === 429) && remaining === "0") {
      throw new GithubRateLimitError();
    }
    throw new Error(`GitHub search request failed (${res.status})`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("GitHub search returned a malformed response");
  }

  if (isGithubErrorResponse(data) && !Array.isArray((data as { items?: unknown }).items)) {
    throw new Error(`GitHub search error: ${data.message}`);
  }

  return data as GithubSearchResponse;
}

/**
 * Fetches one page of AI-relevant repositories via a single search request.
 * Does not call the per-repository detail endpoint or /rate_limit.
 */
export async function getGithubRepositories(perPage: number = DEFAULT_PER_PAGE): Promise<GithubRepository[]> {
  const response = await fetchGithubSearch(buildGithubSearchQuery(), perPage);
  return response.items ?? [];
}

function normalizeDescription(description: string | null): string {
  const trimmed = description?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "No description provided.";
}

/**
 * A light deterministic safety net on top of the topic-scoped query: drops
 * anything whose name/description/topics don't actually look AI-related.
 * No LLM involved — reuses the same keyword list as the Hacker News filter.
 */
function isRelevantRepository(repo: GithubRepository): boolean {
  if (AI_TOPIC_HINTS.some((topic) => repo.topics.includes(topic))) return true;
  const haystack = `${repo.name} ${repo.description ?? ""}`;
  return isAiRelatedTitle(haystack);
}

/**
 * Converts a raw GitHub repository into the app's normalized FeedItem
 * shape. The UI never touches GithubRepository directly.
 */
export function githubRepositoryToFeedItem(repo: GithubRepository): FeedItem {
  return {
    // Source-prefixed so IDs can never collide with other sources (e.g. hn:123456).
    id: `github:${repo.id}`,
    sourceType: "github",
    sourceName: "GitHub",
    title: repo.full_name,
    description: normalizeDescription(repo.description),
    // `pushed_at` reflects real recent activity, which suits a discovery
    // feed better than `created_at` (age) or `updated_at` (metadata-only edits).
    publishedAt: repo.pushed_at,
    // Step 24: persist every topic (up to the shared cap), not just the
    // first 3 — a real sample showed 64% of matched repos have more than
    // 3 topics upstream (max 20). Truncating here silently starved Topics
    // aggregation and keyword search (both consume the full `tags` array)
    // of real signal. The UI applies its own smaller display cap.
    tags: repo.topics.slice(0, MAX_FEED_ITEM_TAGS),
    // GitHub repos have no upvote/comment concept; the explicit stars/forks
    // fields below carry that meaning instead, so score/commentCount stay
    // at 0 and the UI shows a repo-specific metadata row for this source.
    score: 0,
    commentCount: 0,
    url: repo.html_url,
    repositoryFullName: repo.full_name,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    language: repo.language ?? undefined,
    owner: repo.owner.login,
  };
}

export interface GetGithubFeedOptions {
  perPage?: number;
}

/**
 * High-level entry point for the dashboard: fetches recent AI-relevant
 * repositories and returns normalized FeedItems.
 */
export async function getGithubAiFeedItems(options: GetGithubFeedOptions = {}): Promise<FeedItem[]> {
  const { perPage = DEFAULT_PER_PAGE } = options;
  const repositories = await getGithubRepositories(perPage);
  return repositories.filter(isRelevantRepository).map(githubRepositoryToFeedItem);
}

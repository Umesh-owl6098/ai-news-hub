export type SourceType =
  | "news"
  | "paper"
  | "github"
  | "hackernews"
  | "discussion";

/**
 * Step 24 — the persisted cap on `FeedItem.tags` per item, shared across
 * every source adapter (github.ts, arxiv.ts, rss.ts) so they can't
 * silently drift to different bounds. Set to match GitHub's own
 * platform-enforced max of 20 topics per repository — the largest real
 * value observed across all three sources during the Step 24 audit
 * (arXiv: max 5 categories, RSS: max 5 categories, GitHub: up to 20
 * topics) — comfortably generous for real data while still bounding a
 * pathological/malformed upstream response. This replaces an earlier,
 * unjustified `slice(0, 3)` in each adapter that was silently discarding
 * most of a repository's topics (64% of a real sample had more than 3)
 * and a meaningful minority of arXiv/RSS categories (12%/22%). The UI
 * layer applies its OWN, smaller display cap (see FeedCard.tsx's
 * MAX_VISIBLE_TAGS) — this constant only bounds what's persisted and
 * therefore available to Topics aggregation, keyword search (the
 * generated tsvector includes `tags`), and future embedding/evaluation
 * work, none of which should be limited by what a single card can show.
 */
export const MAX_FEED_ITEM_TAGS = 20;

export interface FeedItem {
  id: string;
  sourceType: SourceType;
  sourceName: string;
  /** Machine-readable source key (e.g. "openai", "huggingface") for
   * sources with multiple publishers under one sourceType. */
  sourceId?: string;
  title: string;
  description: string;
  /** ISO 8601 timestamp — the source of truth for sorting. Derive a
   * human-readable relative label for display (see lib/time.ts) rather
   * than storing one. */
  publishedAt: string;
  tags: string[];
  score: number;
  commentCount: number;
  url: string;
  /** Separate link to a source's own discussion thread (e.g. Hacker News comments),
   * shown alongside the external `url` when the two differ. */
  discussionUrl?: string;
  /** Direct link to a downloadable PDF (e.g. an arXiv paper). */
  pdfUrl?: string;
  /** Paper/article authors, shown truncated in the feed card. */
  authors?: string[];
  /** GitHub "owner/repo" — mirrors `title` for GitHub items but kept
   * separately in case `title` is ever shortened. */
  repositoryFullName?: string;
  stars?: number;
  forks?: number;
  language?: string;
  /** GitHub repository owner login. */
  owner?: string;
  thumbnailUrl?: string;
  /** Internal `feed_items.id` — present only when this item came from a
   * database read (search, semantic search, bookmarks, the normal browse
   * path). Absent for mock fixtures and for live-fetched items rendered
   * without a DB round-trip (DB down/unconfigured, or first-run-empty —
   * see `ingestSource`). Drives the Step 19 `/item/[id]` detail link;
   * callers must handle its absence rather than assuming it's always set. */
  dbId?: number;
}

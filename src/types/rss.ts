/** Configuration only — no fetching logic lives here. */
export interface RssSourceConfig {
  id: string;
  name: string;
  feedUrl: string;
  siteUrl: string;
  defaultTags?: string[];
}

/** A parsed, normalized entry from either an RSS 2.0 or Atom feed. */
export interface RssEntry {
  /** Stable identifier: the feed's own guid/id when present, otherwise a
   * canonicalized link. Never random, never positional. */
  id: string;
  title: string;
  link: string;
  description: string;
  /** ISO 8601 timestamp. Entries with no parseable date are dropped before
   * this type is ever constructed. */
  publishedAt: string;
  authors: string[];
  categories: string[];
  sourceId: string;
  sourceName: string;
}

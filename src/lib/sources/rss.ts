import { XMLParser } from "fast-xml-parser";
import { RSS_SOURCES } from "@/data/rssSources";
import { RssEntry, RssSourceConfig } from "@/types/rss";
import { FeedItem, MAX_FEED_ITEM_TAGS } from "@/types/feed";
import { htmlToPlainText } from "@/lib/html";
import { canonicalizeUrl } from "@/lib/url";

const REVALIDATE_SECONDS = 1800; // 30 minutes — publishers don't need constant polling.
const MAX_ENTRIES_PER_SOURCE = 10;
// Step 25: was a flat 40, hand-picked when there were 4 publishers. Once
// a 5th–7th publisher was added (Step 25's Mistral/NVIDIA/Apple ML
// Research), a real refresh measured NVIDIA's near-daily cadence alone
// consuming enough of the cross-publisher top-40-by-recency window to
// starve slower publishers (Mistral, DeepMind) down to 1-2 items each —
// even though all 10 of their entries were fetched and parsed
// successfully; they just lost the global recency sort. Scaling this cap
// with the actual configured publisher count removes the interaction
// entirely — each publisher's own MAX_ENTRIES_PER_SOURCE cap is the only
// real bound now, however many publishers are configured.
const MAX_TOTAL_ITEMS = RSS_SOURCES.length * MAX_ENTRIES_PER_SOURCE;

const RSS_USER_AGENT = "ai-news-hub/0.1 (personal project; RSS reader)";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Step 24 finding: Google Research's feed sets `<description>` to an
 * exact copy of the item's own first `<category>` for 100% of a sampled
 * 100 items (confirmed by inspecting the live feed directly) — it is not
 * a summary at all, just a category label duplicated into the wrong
 * field. Treating it as a real summary would display something
 * misleading ("Health & Bioscience" as if it described the article).
 * This is deliberately narrow: it only fires when the description is an
 * EXACT match (post-normalization) for one of the item's own categories
 * — a real, independently-authored short summary that happens to equal
 * the article's title (observed once, for a different publisher) is
 * NOT caught by this, since a title is not a category.
 */
export function looksLikeCategoryEcho(description: string, categories: string[]): boolean {
  return description.length > 0 && categories.some((category) => category === description);
}

interface MaybeTextNode {
  "#text"?: string;
}

function textOf(value: string | MaybeTextNode | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof value["#text"] === "string") return value["#text"];
  return "";
}

function parseDateToIso(value: string | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// --- RSS 2.0 (<channel><item>) -----------------------------------------

interface RawRssItem {
  title?: string | MaybeTextNode;
  link?: string | MaybeTextNode;
  guid?: string | MaybeTextNode;
  description?: string | MaybeTextNode;
  "content:encoded"?: string | MaybeTextNode;
  pubDate?: string;
  "dc:date"?: string;
  category?: (string | MaybeTextNode) | (string | MaybeTextNode)[];
  "dc:creator"?: string | MaybeTextNode;
  author?: string | MaybeTextNode;
}

function parseRssItem(raw: RawRssItem, source: RssSourceConfig): RssEntry | null {
  const title = normalizeWhitespace(textOf(raw.title));
  const link = textOf(raw.link).trim();
  if (!title || !link) return null;

  const publishedAt = parseDateToIso(raw.pubDate) ?? parseDateToIso(raw["dc:date"]);
  if (!publishedAt) return null;

  const guid = textOf(raw.guid).trim();
  const canonicalLink = canonicalizeUrl(link);

  const categories = toArray(raw.category).map((c) => normalizeWhitespace(textOf(c))).filter(Boolean);

  const rawDescription = textOf(raw.description) || textOf(raw["content:encoded"]);
  const normalizedDescription = htmlToPlainText(rawDescription);
  const description =
    normalizedDescription && !looksLikeCategoryEcho(normalizedDescription, categories)
      ? normalizedDescription
      : "No summary provided.";

  const rawAuthor = textOf(raw["dc:creator"]) || textOf(raw.author);
  const authors = rawAuthor ? [normalizeWhitespace(rawAuthor)] : [];

  return {
    id: guid || canonicalLink,
    title,
    link: canonicalLink,
    description,
    publishedAt,
    authors,
    categories,
    sourceId: source.id,
    sourceName: source.name,
  };
}

// --- Atom (<feed><entry>) ------------------------------------------------

interface RawAtomLink {
  "@_href"?: string;
  "@_rel"?: string;
}

interface RawAtomAuthor {
  name?: string;
}

interface RawAtomCategory {
  "@_term"?: string;
}

interface RawAtomEntry {
  id?: string;
  title?: string | MaybeTextNode;
  link?: RawAtomLink | RawAtomLink[];
  summary?: string | MaybeTextNode;
  content?: string | MaybeTextNode;
  published?: string;
  updated?: string;
  author?: RawAtomAuthor | RawAtomAuthor[];
  category?: RawAtomCategory | RawAtomCategory[];
}

function parseAtomEntry(raw: RawAtomEntry, source: RssSourceConfig): RssEntry | null {
  const title = normalizeWhitespace(textOf(raw.title));
  const links = toArray(raw.link);
  const chosenLink = (links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0])?.["@_href"];
  if (!title || !chosenLink) return null;

  const publishedAt = parseDateToIso(raw.published) ?? parseDateToIso(raw.updated);
  if (!publishedAt) return null;

  const canonicalLink = canonicalizeUrl(chosenLink);
  const categories = toArray(raw.category)
    .map((c) => normalizeWhitespace(c?.["@_term"] ?? ""))
    .filter(Boolean);

  const rawDescription = textOf(raw.summary) || textOf(raw.content);
  const normalizedDescription = htmlToPlainText(rawDescription);
  const description =
    normalizedDescription && !looksLikeCategoryEcho(normalizedDescription, categories)
      ? normalizedDescription
      : "No summary provided.";

  const authors = toArray(raw.author)
    .map((a) => normalizeWhitespace(a?.name ?? ""))
    .filter(Boolean);

  return {
    id: raw.id?.trim() || canonicalLink,
    title,
    link: canonicalLink,
    description,
    publishedAt,
    authors,
    categories,
    sourceId: source.id,
    sourceName: source.name,
  };
}

// --- Fetch + top-level parse ----------------------------------------------

interface RawFeedDocument {
  rss?: { channel?: { item?: RawRssItem | RawRssItem[] } };
  feed?: { entry?: RawAtomEntry | RawAtomEntry[] };
}

/**
 * Parses either an RSS 2.0 or an Atom feed. Throws only when the response
 * doesn't look like a feed at all (malformed/non-XML); a well-formed feed
 * with zero entries returns an empty array rather than throwing.
 */
export function parseRssFeed(xml: string, source: RssSourceConfig): RssEntry[] {
  let parsed: RawFeedDocument;
  try {
    parsed = xmlParser.parse(xml) as RawFeedDocument;
  } catch {
    throw new Error(`Malformed feed XML for ${source.name}`);
  }

  if (!parsed.rss && !parsed.feed) {
    throw new Error(`Unrecognized feed format for ${source.name}`);
  }

  const rssItems = toArray(parsed.rss?.channel?.item);
  if (rssItems.length > 0) {
    return rssItems
      .map((item) => parseRssItem(item, source))
      .filter((entry): entry is RssEntry => entry !== null);
  }

  const atomEntries = toArray(parsed.feed?.entry);
  return atomEntries
    .map((entry) => parseAtomEntry(entry, source))
    .filter((entry): entry is RssEntry => entry !== null);
}

export async function fetchRssFeed(source: RssSourceConfig): Promise<string> {
  let res: Response;
  try {
    res = await fetch(source.feedUrl, {
      headers: {
        "User-Agent": RSS_USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      },
      next: { revalidate: REVALIDATE_SECONDS },
    });
  } catch {
    throw new Error(`Network error fetching ${source.name}`);
  }

  if (!res.ok) {
    throw new Error(`Feed request failed for ${source.name} (${res.status})`);
  }

  return res.text();
}

/**
 * Converts a parsed RSS/Atom entry into the app's normalized FeedItem
 * shape. The UI never touches RssEntry (or raw XML) directly.
 */
export function normalizeRssEntry(entry: RssEntry, source: RssSourceConfig): FeedItem {
  // Step 24: keep every category (up to the shared cap), not just the
  // first 3 — Google Research alone had 22% of items with more than 3
  // categories upstream (max 5 observed).
  const tags = entry.categories.length > 0 ? entry.categories.slice(0, MAX_FEED_ITEM_TAGS) : (source.defaultTags ?? []);

  return {
    // Source-prefixed so IDs can never collide with other sources/publishers.
    id: `rss:${entry.sourceId}:${entry.id}`,
    sourceType: "news",
    sourceName: entry.sourceName,
    sourceId: entry.sourceId,
    title: entry.title,
    description: entry.description,
    publishedAt: entry.publishedAt,
    tags,
    // RSS articles have no upvote/comment concept.
    score: 0,
    commentCount: 0,
    url: entry.link,
    authors: entry.authors.length > 0 ? entry.authors : undefined,
  };
}

async function getFeedItemsForSource(source: RssSourceConfig): Promise<FeedItem[]> {
  const xml = await fetchRssFeed(source);
  const entries = parseRssFeed(xml, source);
  return entries.slice(0, MAX_ENTRIES_PER_SOURCE).map((entry) => normalizeRssEntry(entry, source));
}

export interface RssFeedResult {
  items: FeedItem[];
  /** Publisher display names whose feed could not be fetched/parsed this refresh. */
  failedSourceNames: string[];
}

/**
 * High-level entry point for the dashboard: fetches every configured
 * publisher feed independently and in parallel, so one broken feed never
 * blocks the others, then returns a bounded, chronologically sorted list.
 */
export async function getRssFeedItems(): Promise<RssFeedResult> {
  const settled = await Promise.allSettled(RSS_SOURCES.map(getFeedItemsForSource));

  const items: FeedItem[] = [];
  const failedSourceNames: string[] = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      failedSourceNames.push(RSS_SOURCES[index].name);
    }
  });

  const sorted = [...items].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  return { items: sorted.slice(0, MAX_TOTAL_ITEMS), failedSourceNames };
}

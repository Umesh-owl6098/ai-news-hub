import { XMLParser } from "fast-xml-parser";
import { ArxivEntry } from "@/types/arxiv";
import { FeedItem, MAX_FEED_ITEM_TAGS } from "@/types/feed";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";

// Recent submissions in these categories are treated as "AI news" — no
// separate keyword filter is needed since the query already scopes to
// AI/ML-relevant arXiv categories.
const ARXIV_CATEGORIES = ["cs.AI", "cs.LG", "cs.CL", "cs.CV", "cs.NE", "stat.ML"];

// Papers don't need minute-level freshness.
const REVALIDATE_SECONDS = 900;

// Single bounded request instead of one call per category.
const DEFAULT_MAX_RESULTS = 25;

function buildSearchQuery(): string {
  return ARXIV_CATEGORIES.map((category) => `cat:${category}`).join(" OR ");
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeWhitespace(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function extractArxivId(rawId: unknown): string | null {
  if (typeof rawId !== "string") return null;
  const match = rawId.match(/abs\/([^/]+?)(?:v\d+)?$/);
  return match ? match[1] : null;
}

interface RawAtomLink {
  "@_href"?: string;
  "@_rel"?: string;
  "@_type"?: string;
  "@_title"?: string;
}

interface RawAtomAuthor {
  name?: string;
}

interface RawAtomCategory {
  "@_term"?: string;
}

interface RawAtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  author?: RawAtomAuthor | RawAtomAuthor[];
  category?: RawAtomCategory | RawAtomCategory[];
  link?: RawAtomLink | RawAtomLink[];
  "arxiv:primary_category"?: RawAtomCategory;
}

interface RawAtomFeed {
  feed?: {
    entry?: RawAtomEntry | RawAtomEntry[];
  };
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function parseEntry(raw: RawAtomEntry): ArxivEntry | null {
  const id = extractArxivId(raw.id);
  const title = normalizeWhitespace(raw.title);

  // Skip anything we can't uniquely identify or meaningfully display.
  if (!id || !title) return null;

  const links = toArray(raw.link);
  const htmlLink = links.find(
    (link) => link["@_rel"] === "alternate" && (link["@_type"] === "text/html" || !link["@_type"])
  );
  const pdfLink = links.find((link) => link["@_title"] === "pdf" || link["@_type"] === "application/pdf");

  const authors = toArray(raw.author)
    .map((author) => normalizeWhitespace(author?.name))
    .filter((name) => name.length > 0);

  const categories = toArray(raw.category)
    .map((category) => category?.["@_term"])
    .filter((term): term is string => typeof term === "string" && term.length > 0);

  const primaryCategory = raw["arxiv:primary_category"]?.["@_term"];
  const published = isIsoDateString(raw.published) ? raw.published : new Date().toISOString();
  const updated = isIsoDateString(raw.updated) ? raw.updated : published;

  return {
    id,
    title,
    summary: normalizeWhitespace(raw.summary),
    published,
    updated,
    authors,
    categories,
    primaryCategory: typeof primaryCategory === "string" ? primaryCategory : undefined,
    pdfUrl: pdfLink?.["@_href"],
    abstractUrl: htmlLink?.["@_href"] ?? `https://arxiv.org/abs/${id}`,
  };
}

/**
 * Parses an arXiv Atom feed response into normalized entries. Malformed or
 * incomplete entries (missing id/title) are silently skipped rather than
 * throwing, since a single bad entry shouldn't fail the whole feed.
 */
export function parseArxivFeed(xml: string): ArxivEntry[] {
  let parsed: RawAtomFeed;
  try {
    parsed = xmlParser.parse(xml) as RawAtomFeed;
  } catch {
    throw new Error("Failed to parse arXiv Atom feed");
  }

  const rawEntries = toArray(parsed.feed?.entry);
  const entries: ArxivEntry[] = [];

  for (const raw of rawEntries) {
    const entry = parseEntry(raw);
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Fetches recent AI/ML-relevant arXiv papers via a single bounded query
 * (sorted by submission date, descending) and parses the Atom response.
 */
export async function getArxivEntries(maxResults: number = DEFAULT_MAX_RESULTS): Promise<ArxivEntry[]> {
  const params = new URLSearchParams({
    search_query: buildSearchQuery(),
    sortBy: "submittedDate",
    sortOrder: "descending",
    max_results: String(maxResults),
  });

  const res = await fetch(`${ARXIV_API_URL}?${params.toString()}`, {
    headers: {
      "User-Agent": "ai-news-hub/0.1 (personal project; no API key)",
    },
    next: { revalidate: REVALIDATE_SECONDS },
  });

  if (!res.ok) {
    throw new Error(`arXiv request failed (${res.status})`);
  }

  const xml = await res.text();
  return parseArxivFeed(xml);
}

/**
 * Converts a parsed arXiv entry into the app's normalized FeedItem shape.
 * The UI never touches ArxivEntry (or raw Atom/XML) directly.
 */
export function arxivEntryToFeedItem(entry: ArxivEntry): FeedItem {
  const tags = entry.primaryCategory
    ? [entry.primaryCategory, ...entry.categories.filter((category) => category !== entry.primaryCategory)]
    : entry.categories;

  return {
    // Source-prefixed so IDs can never collide with other sources (e.g. hn:123456).
    id: `arxiv:${entry.id}`,
    sourceType: "paper",
    sourceName: "arXiv",
    title: entry.title,
    description: entry.summary,
    publishedAt: entry.published,
    // Step 24: keep every category (up to the shared cap) rather than
    // just the first 3 — a real sample showed 12% of papers carry more
    // than 3 categories upstream (max 5 observed). Small in magnitude for
    // this source specifically, but the same unjustified truncation as
    // github.ts's topics, fixed for consistency and because Topics
    // aggregation and keyword search both consume the full array.
    tags: tags.slice(0, MAX_FEED_ITEM_TAGS),
    // arXiv has no upvote/comment concept; the UI hides this row for papers.
    score: 0,
    commentCount: 0,
    url: entry.abstractUrl,
    pdfUrl: entry.pdfUrl,
    authors: entry.authors,
  };
}

export interface GetArxivFeedOptions {
  maxResults?: number;
}

/**
 * High-level entry point for the dashboard: fetches recent AI/ML papers and
 * returns normalized FeedItems.
 */
export async function getArxivAiFeedItems(options: GetArxivFeedOptions = {}): Promise<FeedItem[]> {
  const { maxResults = DEFAULT_MAX_RESULTS } = options;
  const entries = await getArxivEntries(maxResults);
  return entries.map(arxivEntryToFeedItem);
}

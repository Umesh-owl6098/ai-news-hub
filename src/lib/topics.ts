import type { FeedItem, SourceType } from "@/types/feed";

/**
 * Recent-activity windows. Deliberately absolute counts within a window,
 * never a recent-vs-previous ratio/"trend" — see the Step 20 final report
 * for why: this corpus's publish timestamps are extremely bursty
 * (ingestion-crawl-driven — e.g. 50 papers landed in one day, 25 in
 * another, with multi-day gaps between), so a prior-window comparison
 * would measure "when a crawl happened to run," not genuine acceleration.
 */
export const TOPIC_WINDOWS = ["24h", "7d", "30d"] as const;
export type TopicWindow = (typeof TOPIC_WINDOWS)[number];

const TOPIC_WINDOW_TO_DAYS: Record<TopicWindow, number> = { "24h": 1, "7d": 7, "30d": 30 };

export function topicWindowToDays(window: TopicWindow): number {
  return TOPIC_WINDOW_TO_DAYS[window];
}

export function isTopicWindow(value: string): value is TopicWindow {
  return (TOPIC_WINDOWS as readonly string[]).includes(value);
}

export const MAX_TOPIC_WINDOW_DAYS = TOPIC_WINDOW_TO_DAYS["30d"];

/**
 * Step 20 — deterministic, database-only topic normalization and
 * aggregation. Pure functions only (no DB, no network, no AI/embedding
 * calls) so this module is fully unit-testable; `src/db/repository.ts`
 * supplies the raw rows this operates on.
 *
 * Corpus inspection (see Step 20 final report) found four structurally
 * different tag vocabularies:
 *   - GitHub: real repo topics, kebab-case, genuinely varied.
 *   - arXiv: standardized taxonomy codes (e.g. "cs.AI") — already
 *     canonical, just not human-readable on their own.
 *   - News/RSS: publisher-assigned categories, Title Case, real content.
 *   - Hacker News: `tags` is the constant placeholder `["Hacker News"]`
 *     for every single item (confirmed: 100% of HN rows) — a source
 *     label, not a subject, and therefore never a valid topic signal.
 * This module's job is normalizing the first three into one comparable
 * slug space, never inventing structure the data doesn't already have.
 */

/** The one confirmed non-topic placeholder tag — see module comment. */
const EXCLUDED_TAGS = new Set(["hacker news"]);

/**
 * Casing/whitespace/punctuation-only normalization — deliberately NOT
 * stemming or pluralization-aware. Collapses e.g. "Machine  Intelligence"
 * and "machine-intelligence" to the same slug, but leaves genuinely
 * different words (or singular/plural pairs not in TOPIC_ALIASES) distinct
 * — merging those would require a linguistic judgment call this milestone
 * explicitly avoids making silently.
 */
export function normalizeTopicSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A small, explicit alias map — added only because the real corpus
 * demonstrated a concrete, unambiguous need: GitHub repo topics included
 * both the singular and plural spelling of the exact same compound word
 * ("agent"/"agents" and "ai-agent"/"ai-agents", confirmed by direct
 * inspection). This is NOT a general singular/plural stemmer — every
 * other near-miss found in the real data (e.g. "agents" vs "ai-agents" vs
 * "agentic-ai" vs "agentic-framework") is a genuinely different compound
 * phrase and is deliberately left unmerged. Keys and values are already
 * normalized slugs (post-`normalizeTopicSlug`).
 */
const TOPIC_ALIASES: Record<string, string> = {
  agent: "agents",
  "ai-agent": "ai-agents",
};

/**
 * Human-readable names for arXiv taxonomy codes actually observed in this
 * corpus (see Step 20 final report for the full inspection) — a small,
 * bounded lookup of real, standard category names, not an invented
 * ontology. A code not in this map still works: it just displays as its
 * raw code, which is itself a legitimate, well-known identifier to this
 * audience — never a broken or hidden topic.
 */
const ARXIV_CATEGORY_LABELS: Record<string, string> = {
  "cs.ai": "Artificial Intelligence",
  "cs.lg": "Machine Learning",
  "cs.cv": "Computer Vision",
  "cs.cl": "Computation and Language",
  "cs.sd": "Sound",
  "cs.ro": "Robotics",
  "cs.hc": "Human-Computer Interaction",
  "cs.ma": "Multiagent Systems",
  "cs.lo": "Logic in Computer Science",
  "cs.ni": "Networking and Internet Architecture",
  "cs.cy": "Computers and Society",
  "cs.dc": "Distributed Computing",
  "cs.gr": "Graphics",
  "cs.ne": "Neural and Evolutionary Computing",
  "cs.cg": "Computational Geometry",
  "cs.ar": "Hardware Architecture",
  "cs.pf": "Performance",
  "cs.ir": "Information Retrieval",
  "stat.ml": "Statistics — Machine Learning",
  "math.oc": "Optimization and Control",
  "math.na": "Numerical Analysis",
  "math.co": "Combinatorics",
  "math.st": "Statistics Theory",
  "eess.sp": "Signal Processing",
  "eess.sy": "Systems and Control",
  "cond-mat.dis-nn": "Disordered Systems and Neural Networks",
  "cond-mat.mtrl-sci": "Materials Science",
  "q-bio.nc": "Neurons and Cognition",
  "physics.plasm-ph": "Plasma Physics",
  "quant-ph": "Quantum Physics",
};

/** arXiv category codes are the one tag shape that needs a display-label
 * lookup (they're canonical but not self-explanatory). Every other source
 * type's raw tag text already reads fine as-is. */
function isLikelyArxivCode(slug: string): boolean {
  return /^[a-z-]+\.[a-z-]+$/.test(slug);
}

export interface RawTopicTag {
  raw: string;
  /** Where this tag came from — kept for provenance, never used to change
   * the slug itself, only to decide the arXiv-label lookup and to report
   * "why this item belongs here" if ever needed. */
  sourceType: SourceType;
}

export interface NormalizedTopicTag {
  slug: string;
  displayLabel: string;
}

/**
 * Normalizes one raw tag into its slug + a human display label. Returns
 * `null` for the confirmed non-topic placeholder (see EXCLUDED_TAGS) or an
 * empty/whitespace-only tag.
 */
export function normalizeTopicTag({ raw, sourceType }: RawTopicTag): NormalizedTopicTag | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (EXCLUDED_TAGS.has(trimmed.toLowerCase())) return null;

  const baseSlug = normalizeTopicSlug(trimmed);
  if (!baseSlug) return null;
  const slug = TOPIC_ALIASES[baseSlug] ?? baseSlug;

  if (sourceType === "paper" && isLikelyArxivCode(baseSlug)) {
    const readable = ARXIV_CATEGORY_LABELS[baseSlug];
    return { slug, displayLabel: readable ? `${readable} (${trimmed})` : trimmed };
  }

  return { slug, displayLabel: trimmed };
}

export interface TopicSourceInput {
  feedItemId: number;
  item: FeedItem;
  tags: string[];
  /** Legitimate, completed AI-enrichment topics for this item, if any —
   * an additional signal layered on top of source-native tags, using the
   * exact same normalization. `null`/`[]` (the common case today, post
   * Step 18C) simply contributes nothing. */
  enrichmentTopics: string[] | null;
}

export interface TopicAggregate {
  slug: string;
  /** The most frequently occurring original raw label for this slug —
   * data-driven, not an arbitrary priority order. */
  label: string;
  totalCount: number;
  sourceTypeCounts: Partial<Record<SourceType, number>>;
  /** Distinct publishers contributing — `sourceId` when the source type
   * has one (News), else `sourceName` (GitHub/arXiv share one constant
   * sourceName each; Hacker News never contributes at all — see above). */
  distinctPublisherCount: number;
  /** Every contributing item, most recent first — the same list backs
   * both the overview's "representative items" (sliced) and the full
   * topic detail page. */
  items: FeedItem[];
  /** True if at least one item's signal came from legitimate AI
   * enrichment rather than only source-native tags. */
  hasEnrichmentSignal: boolean;
}

/**
 * Groups already-fetched, already-time-windowed feed items into topics.
 * Pure and deterministic: the same input always produces the same output,
 * with no DB/network/AI call anywhere in this function. Sorted by
 * `totalCount` descending (ties broken by slug for stable output), which
 * is the "most active" ordering the Topics overview wants — never an
 * opaque relevance score.
 */
export function aggregateTopics(inputs: TopicSourceInput[]): TopicAggregate[] {
  interface Building {
    slug: string;
    labelCounts: Map<string, number>;
    itemIds: Set<number>;
    items: FeedItem[];
    sourceTypeCounts: Partial<Record<SourceType, number>>;
    publishers: Set<string>;
    hasEnrichmentSignal: boolean;
  }
  const bySlug = new Map<string, Building>();

  function addTag(input: TopicSourceInput, raw: string, fromEnrichment: boolean) {
    const normalized = normalizeTopicTag({ raw, sourceType: input.item.sourceType });
    if (!normalized) return;

    let entry = bySlug.get(normalized.slug);
    if (!entry) {
      entry = {
        slug: normalized.slug,
        labelCounts: new Map(),
        itemIds: new Set(),
        items: [],
        sourceTypeCounts: {},
        publishers: new Set(),
        hasEnrichmentSignal: false,
      };
      bySlug.set(normalized.slug, entry);
    }

    entry.labelCounts.set(normalized.displayLabel, (entry.labelCounts.get(normalized.displayLabel) ?? 0) + 1);
    if (fromEnrichment) entry.hasEnrichmentSignal = true;

    // One item can carry the same normalized slug via multiple raw tags
    // (e.g. two near-duplicate GitHub topics aliasing to the same slug) —
    // count the item once regardless.
    if (!entry.itemIds.has(input.feedItemId)) {
      entry.itemIds.add(input.feedItemId);
      entry.items.push(input.item);
      entry.sourceTypeCounts[input.item.sourceType] = (entry.sourceTypeCounts[input.item.sourceType] ?? 0) + 1;
      entry.publishers.add(input.item.sourceId ?? input.item.sourceName);
    }
  }

  for (const input of inputs) {
    for (const tag of input.tags) addTag(input, tag, false);
    for (const tag of input.enrichmentTopics ?? []) addTag(input, tag, true);
  }

  const aggregates: TopicAggregate[] = [...bySlug.values()].map((entry) => {
    let bestLabel = entry.slug;
    let bestCount = -1;
    for (const [label, count] of entry.labelCounts) {
      if (count > bestCount) {
        bestLabel = label;
        bestCount = count;
      }
    }
    return {
      slug: entry.slug,
      label: bestLabel,
      totalCount: entry.itemIds.size,
      sourceTypeCounts: entry.sourceTypeCounts,
      distinctPublisherCount: entry.publishers.size,
      items: entry.items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()),
      hasEnrichmentSignal: entry.hasEnrichmentSignal,
    };
  });

  aggregates.sort((a, b) => b.totalCount - a.totalCount || a.slug.localeCompare(b.slug));
  return aggregates;
}

export function findTopicBySlug(topics: TopicAggregate[], slug: string): TopicAggregate | undefined {
  return topics.find((t) => t.slug === slug);
}

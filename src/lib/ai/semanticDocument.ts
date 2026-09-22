import type { SourceType } from "@/types/feed";

/**
 * Bumped whenever `toSemanticDocument`'s construction rules change in a
 * way that would meaningfully alter the text sent for embedding (a new
 * field included/excluded, reordering that changes meaning, a new
 * truncation bound). Folded into the embedding input hash (see
 * embeddingHash.ts) so a rule change invalidates every cached embedding
 * without a separate backfill step — exactly the role `PROMPT_VERSION`
 * plays for enrichment.
 */
export const EMBEDDING_SCHEMA_VERSION = 1;

/** Bounds the document sent for embedding — a defensive cap, not a tuning
 * knob; nothing in the current field set should realistically approach
 * this, but a pathological input (a huge tag list, say) must never turn
 * into an unbounded embedding request. */
const MAX_SEMANTIC_DOCUMENT_CHARS = 4000;

export interface SemanticDocumentFeedItem {
  title: string;
  /** The feed's own summary/abstract/description — used as a fallback
   * when no AI-generated summary exists yet. */
  summary: string;
  sourceType: SourceType;
  sourceName: string;
  tags: string[] | null;
  authors: string[] | null;
  repositoryFullName: string | null;
}

export interface SemanticDocumentEnrichment {
  summary: string | null;
  topics: string[] | null;
}

/**
 * Builds the deterministic text that gets embedded for one feed item.
 * Pure function: same inputs always produce the same output, no I/O, no
 * timestamps, no randomness, no database IDs.
 *
 * Deliberately prefers the AI-generated summary/topics over raw feed
 * content when present — they're already grounded, concise, and (for
 * Hacker News specifically) avoid embedding either the placeholder
 * "Discussion thread on Hacker News." text or the noisy, unmoderated
 * commenter language from the HN discussion-context cache. This
 * milestone does not embed that raw discussion cache at all — see the
 * Step 17 final report for the rationale.
 *
 * Deliberately excludes: scores, comment counts, timestamps, bookmark
 * state, URLs, database IDs — none of these describe *what the content
 * is about*, which is the only thing semantic similarity should measure.
 */
export function toSemanticDocument(feedItem: SemanticDocumentFeedItem, enrichment?: SemanticDocumentEnrichment | null): string {
  const parts: string[] = [];

  const title = feedItem.title.trim();
  if (title) parts.push(title);

  const bodySummary = enrichment?.summary?.trim() || feedItem.summary.trim();
  if (bodySummary) parts.push(bodySummary);

  if (enrichment?.topics && enrichment.topics.length > 0) {
    parts.push(`Topics: ${enrichment.topics.join(", ")}`);
  }

  if (feedItem.repositoryFullName) {
    parts.push(`Repository: ${feedItem.repositoryFullName}`);
  }

  if (feedItem.tags && feedItem.tags.length > 0) {
    parts.push(`Tags: ${feedItem.tags.join(", ")}`);
  }

  if (feedItem.authors && feedItem.authors.length > 0) {
    parts.push(`Authors: ${feedItem.authors.join(", ")}`);
  }

  // Publisher identity contributes real meaning only for "news" — its
  // `sourceName` is the actual publisher (e.g. "OpenAI", "DeepMind"). For
  // every other source type, `sourceName` is a generic constant ("Hacker
  // News", "arXiv", "GitHub") that's already implied by `sourceType` and
  // would just add repetitive, non-discriminating tokens across the
  // entire corpus.
  if (feedItem.sourceType === "news") {
    parts.push(`Publisher: ${feedItem.sourceName}`);
  }

  const document = parts.join("\n").trim();
  return document.length > MAX_SEMANTIC_DOCUMENT_CHARS ? document.slice(0, MAX_SEMANTIC_DOCUMENT_CHARS) : document;
}

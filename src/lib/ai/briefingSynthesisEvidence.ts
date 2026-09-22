import { createHash } from "node:crypto";
import type { FeedItem, SourceType } from "@/types/feed";
import type { BriefingSections } from "@/lib/briefing";
import type { BriefingSynthesisOutput } from "@/lib/ai/briefingSynthesisSchema";

/**
 * Step 23 — EXPERIMENTAL, evaluation-only (see briefingSynthesisSchema.ts
 * for the "not wired into production" note). Pure functions only: no DB,
 * no network, no AI call — independently unit-testable, mirroring the
 * split between `hash.ts`/`prompt.ts` (pure) and `openaiProvider.ts`
 * (the only network-touching piece) for article enrichment.
 *
 * The evidence boundary (Step 23 §2): the model may only synthesize from
 * exactly what the deterministic `buildBriefing` already selected —
 * never independently browse or re-rank the corpus. Deliberately
 * EXCLUDED from evidence, even though they exist elsewhere in the app:
 *   - embeddings (never a synthesis input)
 *   - raw URLs (the model only ever needs `itemId` to cite a story back)
 *   - bookmark state (not editorial evidence)
 *   - raw HN discussion threads (no legitimately cached context exists
 *     in this corpus today — see Step 22 report; would need explicit
 *     justification if it ever did)
 *   - unbounded article bodies (every text field is clamped below,
 *     mirroring prompt.ts's per-field bounds for enrichment)
 */

const MAX_TITLE_CHARS = 300;
const MAX_SUMMARY_CHARS = 1000;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 80;
const MAX_AUTHORS = 6;
const MAX_AUTHOR_CHARS = 120;

function clamp(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

export type BriefingEvidenceSection = "topStories" | "research" | "projects" | "newsAndDiscussion";

export interface BriefingEvidenceItem {
  /** The FeedItem's own stable sourceKey (`item.id`) — the ONLY handle
   * the model may use to cite a story back. Never the internal numeric
   * DB id (an incidental detail of persistence, not a stable public
   * identity) and never a URL. */
  itemId: string;
  section: BriefingEvidenceSection;
  title: string;
  sourceType: SourceType;
  publisher: string;
  publishedAt: string;
  summary: string | null;
  authors: string[] | null;
  tags: string[] | null;
  hn: { score: number; commentCount: number } | null;
  github: { stars: number | null; forks: number | null; language: string | null } | null;
}

function toEvidenceItem(item: FeedItem, section: BriefingEvidenceSection): BriefingEvidenceItem {
  return {
    itemId: item.id,
    section,
    title: clamp(item.title, MAX_TITLE_CHARS),
    sourceType: item.sourceType,
    publisher: item.sourceName,
    publishedAt: item.publishedAt,
    summary: item.description ? clamp(item.description, MAX_SUMMARY_CHARS) : null,
    authors: item.authors && item.authors.length > 0 ? item.authors.slice(0, MAX_AUTHORS).map((a) => clamp(a, MAX_AUTHOR_CHARS)) : null,
    tags: item.tags.length > 0 ? item.tags.slice(0, MAX_TAGS).map((t) => clamp(t, MAX_TAG_CHARS)) : null,
    hn: item.sourceType === "hackernews" ? { score: item.score, commentCount: item.commentCount } : null,
    github:
      item.sourceType === "github"
        ? { stars: item.stars ?? null, forks: item.forks ?? null, language: item.language ?? null }
        : null,
  };
}

/**
 * Flattens the deterministic briefing's four sections into one ordered
 * evidence list. `buildBriefing` already guarantees no item appears in
 * more than one section, so this never needs to dedupe.
 */
export function buildBriefingEvidence(sections: BriefingSections): BriefingEvidenceItem[] {
  return [
    ...sections.topStories.map((item) => toEvidenceItem(item, "topStories")),
    ...sections.research.map((item) => toEvidenceItem(item, "research")),
    ...sections.projects.map((item) => toEvidenceItem(item, "projects")),
    ...sections.newsAndDiscussion.map((item) => toEvidenceItem(item, "newsAndDiscussion")),
  ];
}

/**
 * Deterministic cache key over exactly what would change the model's
 * input or the contract it must satisfy — the evidence itself, the model
 * name, and the prompt version (mirrors `hash.ts`'s "fold in the prompt
 * version so a prompt change invalidates the cache" convention). Evidence
 * field order is fixed by `toEvidenceItem`'s object-literal construction
 * above, so this is stable across runs given the same underlying corpus.
 */
export function computeEvidenceHash(evidence: BriefingEvidenceItem[], model: string, promptVersion: string): string {
  const canonical = JSON.stringify({ v: promptVersion, model, evidence });
  return createHash("sha256").update(canonical).digest("hex");
}

// --- Automated grounding checks (Step 23 §8) ------------------------------
//
// These can only catch STRUCTURAL problems (an id that doesn't exist, a
// connection with one item, a number the evidence never mentioned) — they
// cannot establish that a claim is true. Every issue is a flag for human
// review, never a verdict.

export interface GroundingIssue {
  severity: "error" | "warning";
  message: string;
}

/**
 * Matches integers/decimals of 2+ digits, with an optional comma
 * thousands-grouped form matched as a single token — long enough to skip
 * common non-factual digits (e.g. "a 3-sentence summary", ordinal-like
 * "1 of 6" list framing) while still catching the numbers that actually
 * matter (scores, star counts, years, versions, percentages). An
 * imprecise heuristic by design — see the module comment.
 *
 * Step 24: a real Luna call wrote "128,379 stars" for evidence whose
 * actual value is the comma-free digit string "128379" (evidence numbers
 * always come from `String(n)`, never formatted). The original pattern
 * had no comma awareness, so it split "128,379" into two unrelated
 * matches — "128" and "379" — neither of which matched evidence, and
 * flagged an exact, correct quote as a false-positive "unsupported
 * number". The grouped alternative is tried first and requires NO space
 * around the comma (`,\d{3}`), so a real list like "128, 379 items"
 * still correctly extracts as two separate numbers, not one — only a
 * genuine thousands grouping is treated as a single token. Commas are
 * stripped before returning so "128,379" and "128379" compare equal.
 */
const NUMBER_PATTERN = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{2,}(?:\.\d+)?\b/g;

function extractNumbers(text: string): string[] {
  const matches = text.match(NUMBER_PATTERN) ?? [];
  return matches.map((match) => match.replace(/,/g, ""));
}

function collectEvidenceNumbers(evidence: BriefingEvidenceItem[]): Set<string> {
  const numbers = new Set<string>();
  for (const item of evidence) {
    for (const n of extractNumbers(item.title)) numbers.add(n);
    if (item.summary) for (const n of extractNumbers(item.summary)) numbers.add(n);
    if (item.hn) {
      numbers.add(String(item.hn.score));
      numbers.add(String(item.hn.commentCount));
    }
    if (item.github) {
      if (item.github.stars != null) numbers.add(String(item.github.stars));
      if (item.github.forks != null) numbers.add(String(item.github.forks));
    }
  }
  return numbers;
}

/**
 * Validates a schema-valid synthesis output against the evidence it was
 * supposedly built from. Checks, in order: every highlight references a
 * real, distinct evidence item; every connection references at least 2
 * DISTINCT and valid evidence items; and a best-effort scan for a
 * precise number appearing in generated text that doesn't appear
 * anywhere in the evidence (flagged as a warning for human review, never
 * treated as proof of fabrication).
 */
export function validateBriefingSynthesisGrounding(
  output: BriefingSynthesisOutput,
  evidence: BriefingEvidenceItem[]
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const validIds = new Set(evidence.map((e) => e.itemId));
  const seenHighlightIds = new Set<string>();

  for (const highlight of output.highlights) {
    if (!validIds.has(highlight.itemId)) {
      issues.push({ severity: "error", message: `highlight references unknown itemId "${highlight.itemId}"` });
    }
    if (seenHighlightIds.has(highlight.itemId)) {
      issues.push({ severity: "error", message: `duplicate highlight itemId "${highlight.itemId}"` });
    }
    seenHighlightIds.add(highlight.itemId);
  }

  for (const connection of output.connections ?? []) {
    const distinctIds = new Set(connection.itemIds);
    if (distinctIds.size < 2) {
      issues.push({ severity: "error", message: "connection must reference at least 2 distinct itemIds" });
    }
    for (const id of distinctIds) {
      if (!validIds.has(id)) {
        issues.push({ severity: "error", message: `connection references unknown itemId "${id}"` });
      }
    }
  }

  const evidenceNumbers = collectEvidenceNumbers(evidence);
  const textsToCheck: { field: string; text: string }[] = [
    { field: "headline", text: output.headline },
    { field: "overview", text: output.overview },
    ...output.highlights.map((h, i) => ({ field: `highlights[${i}].summary`, text: h.summary })),
    ...output.highlights
      .filter((h) => h.whyItMatters)
      .map((h, i) => ({ field: `highlights[${i}].whyItMatters`, text: h.whyItMatters! })),
    ...(output.connections ?? []).map((c, i) => ({ field: `connections[${i}].observation`, text: c.observation })),
  ];
  for (const { field, text } of textsToCheck) {
    for (const num of extractNumbers(text)) {
      if (!evidenceNumbers.has(num)) {
        issues.push({
          severity: "warning",
          message: `possible unsupported number "${num}" in ${field} — not found anywhere in the supplied evidence`,
        });
      }
    }
  }

  return issues;
}

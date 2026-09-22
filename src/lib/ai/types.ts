import type { EnrichmentOutput } from "@/lib/ai/schema";

/**
 * Trusted, normalized fields sent to a model — always sourced from our own
 * `feed_items` row, never from raw request input. Everything here is
 * treated as untrusted *content* once inside the prompt (see prompt.ts):
 * article titles/summaries are external text a publisher wrote, not
 * instructions to the assistant.
 */
export interface ArticleEnrichmentInput {
  title: string;
  sourceName: string;
  summary: string;
  authors?: string[];
  tags?: string[];
  repositoryFullName?: string;
  owner?: string;
  language?: string;
  /**
   * Optional, clearly-labeled additional source material (Step 13 input-
   * quality experiment) — e.g. Hacker News discussion context fetched via
   * the official Firebase API. Absent for every production call today;
   * when present, `prompt.ts` renders it in its own delimited block and
   * `hash.ts` folds it into the input hash so augmented input is never
   * mistaken for a cache hit against a baseline (context-less) run.
   * `label` names what kind of material this is (rendered as a heading),
   * `text` is the untrusted content itself.
   */
  sourceContext?: { label: string; text: string };
}

export type ArticleEnrichmentResult = EnrichmentOutput;

/**
 * Token counts as reported by the provider's own API response — never
 * estimated or fabricated by this app. Optional per-field (not just
 * optional as a whole): a provider may report one field and not the
 * other, and different providers expose different subsets.
 */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProviderCallResult {
  output: ArticleEnrichmentResult;
  /** Absent when the provider's response didn't include usage data (the
   * mock provider never does). Consumers must handle "unknown," never
   * assume zero. */
  usage?: ProviderUsage;
}

/**
 * Safe-to-log, safe-to-surface error classification — never the raw
 * provider exception (which may embed request/response bodies).
 */
export type ProviderErrorCode =
  | "not_configured"
  | "rate_limited"
  | "timeout"
  | "invalid_output"
  | "provider_error";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

/**
 * The one seam application code depends on. Swapping models/providers
 * later means writing a new class that satisfies this interface — never
 * touching ingestion, the repository, the enrichment service, or the UI.
 */
export interface AiProvider {
  /** Short identifier persisted alongside each enrichment row, e.g. "anthropic", "mock". */
  readonly name: string;
  /** Specific model identifier persisted alongside each enrichment row. */
  readonly model: string;
  enrichArticle(input: ArticleEnrichmentInput): Promise<ProviderCallResult>;
}

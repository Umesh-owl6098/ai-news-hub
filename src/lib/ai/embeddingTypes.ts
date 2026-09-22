/**
 * Analogous to `types.ts`'s `AiProvider` seam for enrichment: the one
 * interface application code depends on for turning text into vectors.
 * Deliberately minimal — OpenAI is the only real provider needed now (see
 * Step 17 final report), so this is not a generalized multi-provider
 * framework.
 */
export interface EmbeddingUsage {
  /** Present only when the provider's response includes it (OpenAI's
   * embeddings API reports `usage.prompt_tokens`; there is no separate
   * "output" token concept for embeddings). */
  inputTokens?: number;
}

export interface EmbeddingResult {
  embedding: number[];
  /** Always `embedding.length` — computed by the adapter for convenience,
   * re-validated by the caller before persisting (see embeddingService.ts). */
  dimensions: number;
}

export interface EmbeddingBatchResult {
  /** Same order and length as the input `texts` array. */
  embeddings: EmbeddingResult[];
  usage?: EmbeddingUsage;
}

export type EmbeddingErrorCode =
  | "not_configured"
  | "rate_limited"
  | "timeout"
  | "invalid_output"
  | "provider_error";

export class EmbeddingProviderError extends Error {
  readonly code: EmbeddingErrorCode;

  constructor(code: EmbeddingErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.code = code;
  }
}

export interface EmbeddingProvider {
  /** Short identifier persisted alongside each embedding row, e.g. "openai", "mock". */
  readonly name: string;
  /** Specific embedding model identifier persisted alongside each row —
   * always the explicitly configured value (see embeddingProvider.ts),
   * never inferred or defaulted. */
  readonly model: string;
  /** Batch-capable: callers should prefer one call per bounded batch over
   * one call per text. Must reject (never silently truncate) a batch
   * larger than the provider's own bound. */
  embed(texts: string[]): Promise<EmbeddingBatchResult>;
}

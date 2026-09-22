import "server-only";
import { getEmbeddingCandidates, upsertFeedItemEmbedding, type EmbeddingCandidate } from "@/db/repository";
import { getEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import { toSemanticDocument, EMBEDDING_SCHEMA_VERSION } from "@/lib/ai/semanticDocument";
import { computeEmbeddingInputHash } from "@/lib/ai/embeddingHash";
import { EmbeddingProviderError, type EmbeddingProvider, type EmbeddingUsage } from "@/lib/ai/embeddingTypes";
import type { SourceType } from "@/types/feed";

// --- Cost/safety guardrails ---------------------------------------------
// Hard bounds, matching the discipline already established for enrichment
// (enrichmentService.ts) — a caller cannot request a larger batch than
// this by passing a bigger number.
export const DEFAULT_EMBED_BATCH_LIMIT = 20;
export const MAX_EMBED_BATCH_LIMIT = 50;
const CANDIDATE_POOL_MULTIPLIER = 3;
const MAX_CANDIDATE_POOL = 150;

function resolveBatchLimit(requested: number | undefined): number {
  const value = requested ?? DEFAULT_EMBED_BATCH_LIMIT;
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), MAX_EMBED_BATCH_LIMIT) : DEFAULT_EMBED_BATCH_LIMIT;
}

interface ResolvedEmbeddingCandidate {
  candidate: EmbeddingCandidate;
  document: string;
  inputHash: string;
  cacheCurrent: boolean;
}

/**
 * Shared pool-fetch-and-hash-check step, mirroring
 * `enrichmentService.ts`'s `resolveCandidatePool` — the dry-run preview
 * and the real batch path must never silently disagree on what counts as
 * "needs embedding."
 */
async function resolveEmbeddingCandidatePool(options: {
  limit: number;
  sourceType?: SourceType;
  sourceKeyPrefix?: string;
  provider: string;
  model: string;
}): Promise<ResolvedEmbeddingCandidate[]> {
  const poolSize = Math.min(options.limit * CANDIDATE_POOL_MULTIPLIER, MAX_CANDIDATE_POOL);
  const candidates = await getEmbeddingCandidates({
    poolSize,
    sourceType: options.sourceType,
    sourceKeyPrefix: options.sourceKeyPrefix,
    provider: options.provider,
    model: options.model,
    embeddingVersion: EMBEDDING_SCHEMA_VERSION,
  });

  return candidates.map((candidate) => {
    const document = toSemanticDocument(candidate, {
      summary: candidate.enrichmentSummary,
      topics: candidate.enrichmentTopics,
    });
    const inputHash = computeEmbeddingInputHash(document, options.model, EMBEDDING_SCHEMA_VERSION);
    return { candidate, document, inputHash, cacheCurrent: candidate.existingInputHash === inputHash };
  });
}

export interface EmbeddingCandidatePreview {
  sourceKey: string;
  title: string;
  sourceName: string;
  cacheCurrent: boolean;
  /** False whenever no provider is configured yet, regardless of
   * cacheCurrent — mirrors `CandidatePreview.wouldCallProvider` for
   * enrichment. */
  wouldEmbed: boolean;
}

/**
 * Read-only preview of what `embedRecentItems` would do. Performs zero
 * provider calls and zero database writes, guaranteed structurally: this
 * function never imports or calls `upsertFeedItemEmbedding`. Works even
 * before an embedding model is configured — it still shows the corpus and
 * marks every item as "would embed: false" until a model is set, since
 * currency can't be evaluated without a model identity to hash against.
 */
export async function previewEmbeddingCandidates(
  options: { limit?: number; sourceType?: SourceType; sourceKeyPrefix?: string } = {}
): Promise<{ providerConfigured: boolean; items: EmbeddingCandidatePreview[] }> {
  const provider = getEmbeddingProvider();
  const providerConfigured = provider !== null;
  const limit = resolveBatchLimit(options.limit);

  const resolved = await resolveEmbeddingCandidatePool({
    limit,
    sourceType: options.sourceType,
    sourceKeyPrefix: options.sourceKeyPrefix,
    provider: provider?.name ?? "unconfigured",
    model: provider?.model ?? "unconfigured",
  });

  const items: EmbeddingCandidatePreview[] = resolved.slice(0, limit).map(({ candidate, cacheCurrent }) => ({
    sourceKey: candidate.sourceKey,
    title: candidate.title,
    sourceName: candidate.sourceName,
    cacheCurrent,
    wouldEmbed: providerConfigured && !cacheCurrent,
  }));

  return { providerConfigured, items };
}

/**
 * Only ever describes an item that was actually passed to the provider —
 * an already-current item is filtered out before this batch runs at all
 * (see `resolveEmbeddingCandidatePool`'s `cacheCurrent` check) and simply
 * never appears here, exactly like `enrichRecentItems`'s normal (non-
 * force) path. `previewEmbeddingCandidates`'s `cacheCurrent` field is
 * where "already current" status is surfaced, not this type.
 */
export type EmbedOutcome =
  | { sourceKey: string; status: "embedded"; latencyMs: number; usage?: EmbeddingUsage }
  | { sourceKey: string; status: "failed"; errorCode: string };

export interface EmbedRecentItemsOptions {
  limit?: number;
  sourceType?: SourceType;
  /** Test-only candidate scoping — see `getEmbeddingCandidates`'s
   * `sourceKeyPrefix`. No production call site sets this. */
  sourceKeyPrefix?: string;
  provider?: EmbeddingProvider;
}

export interface EmbedRecentItemsResult {
  providerConfigured: boolean;
  outcomes: EmbedOutcome[];
}

/**
 * Bounded batch entry point — the only way embedding runs against more
 * than one item at a time. Skips items whose current semantic input hash
 * already has a matching embedding row for this exact (provider, model,
 * embeddingVersion); embeds only missing/stale items, in ONE provider
 * call for the whole eligible batch (embeddings, unlike enrichment, are
 * naturally batchable — see openaiEmbeddingProvider.ts). A batch-level
 * provider failure is caught and reported as a "failed" outcome for every
 * item in that batch, never left to crash the CLI or corrupt a partial
 * write.
 */
export async function embedRecentItems(options: EmbedRecentItemsOptions = {}): Promise<EmbedRecentItemsResult> {
  const provider = options.provider ?? getEmbeddingProvider();
  if (!provider) {
    return { providerConfigured: false, outcomes: [] };
  }

  const limit = resolveBatchLimit(options.limit);
  const resolved = await resolveEmbeddingCandidatePool({
    limit,
    sourceType: options.sourceType,
    sourceKeyPrefix: options.sourceKeyPrefix,
    provider: provider.name,
    model: provider.model,
  });
  const eligible = resolved.filter(({ cacheCurrent }) => !cacheCurrent).slice(0, limit);

  if (eligible.length === 0) {
    return { providerConfigured: true, outcomes: [] };
  }

  const startedAt = Date.now();
  let batchResult;
  try {
    batchResult = await provider.embed(eligible.map(({ document }) => document));
  } catch (error) {
    const errorCode = error instanceof EmbeddingProviderError ? error.code : "provider_error";
    return {
      providerConfigured: true,
      outcomes: eligible.map(({ candidate }) => ({ sourceKey: candidate.sourceKey, status: "failed", errorCode })),
    };
  }
  const latencyMs = Date.now() - startedAt;

  const outcomes: EmbedOutcome[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const { candidate, inputHash } = eligible[i];
    const result = batchResult.embeddings[i];
    if (!result) {
      outcomes.push({ sourceKey: candidate.sourceKey, status: "failed", errorCode: "invalid_output" });
      continue;
    }
    try {
      await upsertFeedItemEmbedding({
        feedItemId: candidate.feedItemId,
        provider: provider.name,
        model: provider.model,
        embeddingVersion: EMBEDDING_SCHEMA_VERSION,
        inputHash,
        embedding: result.embedding,
        dimensions: result.dimensions,
      });
      outcomes.push({ sourceKey: candidate.sourceKey, status: "embedded", latencyMs, usage: batchResult.usage });
    } catch {
      outcomes.push({ sourceKey: candidate.sourceKey, status: "failed", errorCode: "provider_error" });
    }
  }

  return { providerConfigured: true, outcomes };
}

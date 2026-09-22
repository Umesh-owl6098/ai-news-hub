import "server-only";
import {
  getFeedItemForEnrichment,
  getEnrichmentByFeedItemId,
  markEnrichmentProcessing,
  markEnrichmentCompleted,
  markEnrichmentFailed,
  getEnrichmentCandidates,
  getStaleHnMaintenanceCandidates,
  type EnrichmentCandidate,
} from "@/db/repository";
import { getAiProvider } from "@/lib/ai/provider";
import { computeInputHash } from "@/lib/ai/hash";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { peekCachedHnContext, resolveHnSourceContext, HN_CONTEXT_TTL_MS } from "@/lib/ai/hnContextCache";
import type {
  AiProvider,
  ArticleEnrichmentInput,
  ArticleEnrichmentResult,
  ProviderErrorCode,
  ProviderUsage,
} from "@/lib/ai/types";
import { ProviderError } from "@/lib/ai/types";
import type { SourceType } from "@/types/feed";
import type { EnrichmentStatus } from "@/db/schema";

// --- Cost/safety guardrails ---------------------------------------------
// Hard bounds, not suggestions: a caller (including the CLI) cannot
// request more concurrency, a larger batch, or more retries than this by
// passing a bigger number — every entry point clamps to these.
export const DEFAULT_BATCH_LIMIT = 5;
export const MAX_BATCH_LIMIT = 10;
const CANDIDATE_POOL_MULTIPLIER = 5;
const MAX_CANDIDATE_POOL = 50;
const RETRYABLE_CODES: readonly ProviderErrorCode[] = ["timeout", "rate_limited"];
const RETRY_DELAY_MS = 300;

/**
 * Exported so anything that needs to build the exact same model input the
 * production pipeline would (e.g. a model-comparison experiment) can
 * reuse this instead of re-deriving it slightly differently — two
 * candidate providers being compared must see byte-identical input, or a
 * quality difference could just be an input difference in disguise.
 */
export function toEnrichmentInput(item: {
  title: string;
  sourceName: string;
  summary: string;
  authors: string[] | null;
  tags: string[] | null;
  repositoryFullName: string | null;
  owner: string | null;
  language: string | null;
}): ArticleEnrichmentInput {
  return {
    title: item.title,
    sourceName: item.sourceName,
    summary: item.summary,
    authors: item.authors ?? undefined,
    tags: item.tags ?? undefined,
    repositoryFullName: item.repositoryFullName ?? undefined,
    owner: item.owner ?? undefined,
    language: item.language ?? undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls the provider with one conservative retry for clearly-transient
 * failures (a slow/overloaded upstream). Never retries `invalid_output`
 * (a bad response won't fix itself), `not_configured` (nothing to call),
 * or the generic `provider_error` bucket (treated as a permanent failure
 * — auth errors, 4xx/5xx that aren't rate limits, etc. all land there).
 */
async function callWithRetry(
  provider: AiProvider,
  input: ArticleEnrichmentInput
): Promise<{ output: ArticleEnrichmentResult; usage?: ProviderUsage }> {
  try {
    return await provider.enrichArticle(input);
  } catch (error) {
    if (error instanceof ProviderError && RETRYABLE_CODES.includes(error.code)) {
      await sleep(RETRY_DELAY_MS);
      return provider.enrichArticle(input);
    }
    throw error;
  }
}

export type EnrichOutcome =
  | { status: "not_configured"; sourceKey: string }
  | { status: "skipped_current"; sourceKey: string }
  | {
      status: "completed";
      sourceKey: string;
      output: ArticleEnrichmentResult;
      /** Wall-clock time for the provider call (including any retry), in
       * ms. Absent for the mock provider only in the sense that it's
       * still measured — it just tends to be ~0. */
      latencyMs: number;
      /** Present only when the provider's response included it. */
      usage?: ProviderUsage;
      /** `null` when usage is missing or the model has no verified
       * pricing entry (see pricing.ts) — never a guessed number. */
      estimatedCostUsd: number | null;
    }
  | { status: "failed"; sourceKey: string; errorCode: ProviderErrorCode };

/**
 * The full enrichment flow for one item:
 *
 *   load -> compute input hash -> skip if a completed run already has
 *   this exact hash -> mark processing -> call provider (with bounded
 *   retry) -> validate (enforced inside the provider adapter) -> persist
 *
 * Never called during page rendering — only from the batch function below
 * and the dev CLI script. A missing provider is not an error: it's
 * reported as `not_configured` and no database row is touched, so running
 * this with no API key configured is a safe, cheap no-op.
 */
export async function enrichFeedItem(
  sourceKey: string,
  options: { provider?: AiProvider; force?: boolean } = {}
): Promise<EnrichOutcome> {
  const item = await getFeedItemForEnrichment(sourceKey);
  if (!item) {
    throw new Error(`enrichFeedItem: no feed item found for sourceKey "${sourceKey}"`);
  }

  // For Hacker News items only: reuse a fresh cached discussion context
  // with zero HN API calls, refresh it when stale, and gracefully fall
  // back to a stale-but-valid cache (or no context at all) if Hacker
  // News is unreachable. A no-op for every other source type.
  const sourceContext = await resolveHnSourceContext(sourceKey, item.feedItemId);
  const input: ArticleEnrichmentInput = { ...toEnrichmentInput(item), sourceContext };
  const inputHash = computeInputHash(input, PROMPT_VERSION);

  const existing = await getEnrichmentByFeedItemId(item.feedItemId);
  // `force` intentionally bypasses this cache check — see the CLI's
  // `--force` flag, which is the only caller allowed to set it, and only
  // ever on an explicit, bounded, non-default request.
  if (!options.force && existing?.status === "completed" && existing.inputHash === inputHash) {
    return { status: "skipped_current", sourceKey };
  }

  const provider = options.provider ?? getAiProvider();
  if (!provider) {
    return { status: "not_configured", sourceKey };
  }

  await markEnrichmentProcessing({
    feedItemId: item.feedItemId,
    provider: provider.name,
    model: provider.model,
    promptVersion: PROMPT_VERSION,
    inputHash,
  });

  const startedAt = Date.now();
  try {
    const { output, usage } = await callWithRetry(provider, input);
    const latencyMs = Date.now() - startedAt;
    await markEnrichmentCompleted({
      feedItemId: item.feedItemId,
      summary: output.summary,
      topics: output.topics,
      relevanceScore: output.relevanceScore,
    });
    return {
      status: "completed",
      sourceKey,
      output,
      latencyMs,
      usage,
      estimatedCostUsd: estimateCostUsd(provider.model, usage),
    };
  } catch (error) {
    // Guarantees a row is never left stuck on "processing" — every
    // failure path here (including a bug we didn't anticipate) still
    // resolves to an explicit "failed" status.
    const errorCode: ProviderErrorCode = error instanceof ProviderError ? error.code : "provider_error";
    await markEnrichmentFailed(item.feedItemId, errorCode);
    return { status: "failed", sourceKey, errorCode };
  }
}

/** Clamps a requested batch size into [1, MAX_BATCH_LIMIT], falling back
 * to the default for anything non-finite (NaN, Infinity, malformed CLI
 * input already coerced upstream) rather than propagating a bad value. */
function resolveBatchLimit(requested: number | undefined): number {
  const value = requested ?? DEFAULT_BATCH_LIMIT;
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), MAX_BATCH_LIMIT) : DEFAULT_BATCH_LIMIT;
}

/**
 * "normal" — needs enrichment at all (missing, failed, or stale content).
 * "stale_hn_context" — already `completed` with current content, but its
 * cached Hacker News discussion context is missing or past its TTL and
 * deserves a context-refresh check (see hnContextCache.ts). Being in this
 * pool means "worth checking," never "will call the model" — that second
 * decision is made by `enrichFeedItem` itself, after the refresh, purely
 * from the resulting input hash.
 */
export type CandidateKind = "normal" | "stale_hn_context";

export interface CandidatePreview {
  sourceKey: string;
  title: string;
  sourceName: string;
  /** null = never attempted. */
  currentStatus: EnrichmentStatus | null;
  /** Whether the existing (if any) enrichment's input hash still matches
   * this item's current content — i.e. would be skipped without `force`. */
  cacheCurrent: boolean;
  candidateKind: CandidateKind;
  /** What would actually happen if this item were processed right now.
   * `"uncertain"` only for `stale_hn_context` candidates: a dry run can't
   * know whether a live Hacker News refresh will turn up changed content
   * without actually making that call, and this preview makes zero
   * network calls by design — so it reports the real uncertainty instead
   * of guessing. */
  wouldCallProvider: boolean | "uncertain";
}

interface ResolvedCandidate {
  candidate: Awaited<ReturnType<typeof getEnrichmentCandidates>>[number];
  cacheCurrent: boolean;
}

/**
 * Shared pool-fetch-and-hash-check step used by both the real batch path
 * and the read-only dry-run preview, so the two can never silently drift
 * apart on what counts as "eligible."
 */
async function resolveCandidatePool(options: {
  limit: number;
  sourceType?: SourceType;
  sourceKeyPrefix?: string;
  includeCompleted: boolean;
}): Promise<ResolvedCandidate[]> {
  const poolSize = Math.min(options.limit * CANDIDATE_POOL_MULTIPLIER, MAX_CANDIDATE_POOL);
  const candidates = await getEnrichmentCandidates({
    poolSize,
    sourceType: options.sourceType,
    sourceKeyPrefix: options.sourceKeyPrefix,
    includeCompleted: options.includeCompleted,
  });

  // The DB query alone can't detect "completed, but source content
  // changed since" — that requires recomputing the hash in-process. For
  // HN candidates this must include whatever context is CURRENTLY
  // cached (read-only — never a live HN call here) so the eligibility
  // check and the dry-run preview agree with what enrichFeedItem would
  // actually see; peekCachedHnContext is a no-op for non-HN items.
  return Promise.all(
    candidates.map(async (candidate) => {
      const sourceContext = await peekCachedHnContext(candidate.feedItemId, candidate.sourceKey);
      const input: ArticleEnrichmentInput = { ...toEnrichmentInput(candidate), sourceContext };
      const inputHash = computeInputHash(input, PROMPT_VERSION);
      return { candidate, cacheCurrent: candidate.existingStatus === "completed" && candidate.existingInputHash === inputHash };
    })
  );
}

/**
 * Step 16 fairness policy (§6): normal candidates always fill first; stale
 * HN-context maintenance candidates only fill whatever's left of `limit`
 * after that. A large backlog of stale-context items can therefore never
 * starve fresh/normal work, and `--limit` stays a true upper bound on the
 * combined total — never a scheduler, never a priority queue, just "top up
 * the remainder." Never runs under `--force` (which already reconsiders
 * every recent item via `includeCompleted: true`, making a separate
 * maintenance pass redundant) and never runs for a `--source` filter other
 * than `hackernews` (the maintenance pool is HN-only by construction).
 */
async function resolveMaintenanceFill(options: {
  normalEligibleCount: number;
  limit: number;
  sourceType?: SourceType;
  sourceKeyPrefix?: string;
}): Promise<EnrichmentCandidate[]> {
  if (options.sourceType && options.sourceType !== "hackernews") return [];
  const remaining = options.limit - options.normalEligibleCount;
  if (remaining <= 0) return [];
  return getStaleHnMaintenanceCandidates({ poolSize: remaining, ttlMs: HN_CONTEXT_TTL_MS, sourceKeyPrefix: options.sourceKeyPrefix });
}

function maintenanceCandidateToPreview(candidate: EnrichmentCandidate, providerConfigured: boolean): CandidatePreview {
  return {
    sourceKey: candidate.sourceKey,
    title: candidate.title,
    sourceName: candidate.sourceName,
    currentStatus: candidate.existingStatus,
    // By definition true: nothing about the stored input has changed yet —
    // only the cached HN context is due for a refresh check.
    cacheCurrent: true,
    candidateKind: "stale_hn_context",
    wouldCallProvider: providerConfigured ? "uncertain" : false,
  };
}

/**
 * Read-only preview of what `enrichRecentItems` would do — see the CLI's
 * `--dry-run` flag. Performs zero provider calls, zero Hacker News calls,
 * and zero database writes, guaranteed structurally: this function never
 * imports or calls anything from the mark-processing/completed/failed
 * write path, and reads the HN context cache only via the read-only
 * `peekCachedHnContext` (never `resolveHnSourceContext`, which can write).
 */
export async function previewEligibleCandidates(
  options: { limit?: number; sourceType?: SourceType; sourceKeyPrefix?: string; force?: boolean } = {}
): Promise<{ providerConfigured: boolean; items: CandidatePreview[] }> {
  const limit = resolveBatchLimit(options.limit);
  const providerConfigured = getAiProvider() !== null;
  const force = options.force === true;

  const resolved = await resolveCandidatePool({
    limit,
    sourceType: options.sourceType,
    sourceKeyPrefix: options.sourceKeyPrefix,
    includeCompleted: true,
  });

  const normalItems: CandidatePreview[] = resolved.slice(0, limit).map(({ candidate, cacheCurrent }) => ({
    sourceKey: candidate.sourceKey,
    title: candidate.title,
    sourceName: candidate.sourceName,
    currentStatus: candidate.existingStatus,
    cacheCurrent,
    candidateKind: "normal",
    wouldCallProvider: providerConfigured && (force || !cacheCurrent),
  }));

  // Mirrors enrichRecentItems's own eligibility filter (not just the
  // display slice above) so the maintenance fill-in reflects how many
  // slots a real run would actually spend on normal candidates.
  const normalEligibleCount = resolved.filter(({ cacheCurrent }) => force || !cacheCurrent).slice(0, limit).length;

  const maintenanceCandidates = force
    ? []
    : await resolveMaintenanceFill({ normalEligibleCount, limit, sourceType: options.sourceType, sourceKeyPrefix: options.sourceKeyPrefix });
  const maintenanceItems = maintenanceCandidates.map((candidate) => maintenanceCandidateToPreview(candidate, providerConfigured));

  return { providerConfigured, items: [...normalItems, ...maintenanceItems] };
}

export interface EnrichRecentItemsOptions {
  limit?: number;
  sourceType?: SourceType;
  /** Test-only candidate scoping — see `getEnrichmentCandidates`'s
   * `sourceKeyPrefix`. No production call site sets this. */
  sourceKeyPrefix?: string;
  provider?: AiProvider;
  /** Explicit, bounded, never-default override that re-processes items
   * even when their cached enrichment is current — see the CLI's
   * `--force` flag. Still subject to MAX_BATCH_LIMIT like every other
   * path; this only changes *which* items are eligible, never how many. */
  force?: boolean;
}

export interface EnrichRecentItemsResult {
  providerConfigured: boolean;
  outcomes: EnrichOutcome[];
}

/**
 * Bounded batch entry point — the only way enrichment runs against more
 * than one item at a time. `limit` is clamped to [1, MAX_BATCH_LIMIT]
 * regardless of what the caller (including malformed CLI input) passes.
 * Candidates are processed strictly sequentially (no concurrency), and a
 * single item's unexpected exception is isolated so it can't abort the
 * rest of the batch.
 */
export async function enrichRecentItems(options: EnrichRecentItemsOptions = {}): Promise<EnrichRecentItemsResult> {
  const provider = options.provider ?? getAiProvider();
  if (!provider) {
    return { providerConfigured: false, outcomes: [] };
  }

  const limit = resolveBatchLimit(options.limit);
  const force = options.force === true;

  const resolved = await resolveCandidatePool({
    limit,
    sourceType: options.sourceType,
    sourceKeyPrefix: options.sourceKeyPrefix,
    includeCompleted: force,
  });
  const normalEligible = resolved.filter(({ cacheCurrent }) => force || !cacheCurrent).slice(0, limit);

  // Maintenance candidates fill only the remainder of `limit` left after
  // normal candidates — see resolveMaintenanceFill. Passing them straight
  // to enrichFeedItem (never `force`) is what makes this safe: it will
  // refresh the HN context and only call the model if the resulting input
  // hash actually changed, exactly like any other stale-but-unforced item.
  const maintenanceEligible = force
    ? []
    : await resolveMaintenanceFill({
        normalEligibleCount: normalEligible.length,
        limit,
        sourceType: options.sourceType,
        sourceKeyPrefix: options.sourceKeyPrefix,
      });

  const sourceKeys = [
    ...normalEligible.map(({ candidate }) => candidate.sourceKey),
    ...maintenanceEligible.map((candidate) => candidate.sourceKey),
  ];

  const outcomes: EnrichOutcome[] = [];
  for (const sourceKey of sourceKeys) {
    try {
      outcomes.push(await enrichFeedItem(sourceKey, { provider, force }));
    } catch (error) {
      console.error(`[ai:enrich] unexpected failure for ${sourceKey}:`, error);
      outcomes.push({ status: "failed", sourceKey, errorCode: "provider_error" });
    }
  }

  return { providerConfigured: true, outcomes };
}

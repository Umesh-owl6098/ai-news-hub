import type { BriefingEvidenceItem } from "@/lib/ai/briefingSynthesisEvidence";
import { computeEvidenceHash, validateBriefingSynthesisGrounding } from "@/lib/ai/briefingSynthesisEvidence";
import { BRIEFING_SYNTHESIS_PROMPT_VERSION } from "@/lib/ai/briefingSynthesisPrompt";
import type { BriefingSynthesisProvider } from "@/lib/ai/briefingSynthesisProvider";
import {
  readCachedBriefingSynthesis,
  writeCachedBriefingSynthesis,
  BRIEFING_SYNTHESIS_CACHE_DIR,
  type CachedBriefingSynthesis,
} from "@/lib/ai/briefingSynthesisCache";
import { estimateCostUsd } from "@/lib/ai/pricing";

/**
 * Step 23 — EXPERIMENTAL, evaluation-only (see briefingSynthesisSchema.ts
 * for the "not wired into production" note). The one orchestration
 * function `scripts/ai-briefing-evaluate.ts` calls — mirrors
 * `runFullEvaluation` (evaluationHarness.ts)'s role for article
 * enrichment: the CLI script stays a thin printer/formatter, this holds
 * the actual cache/call/grounding logic so it's independently testable
 * with a mock provider and zero real network calls.
 */
export interface RunBriefingSynthesisOptions {
  provider: BriefingSynthesisProvider;
  cacheDir?: string;
  /** Bypasses the cache and always calls the provider, even if a cached
   * result already exists for this exact evidence/model/prompt-version
   * combination. Mirrors `--force` in ai-enrich.ts. */
  force?: boolean;
}

export interface RunBriefingSynthesisResult {
  cacheHit: boolean;
  /** 0 or 1 — this experiment only ever makes at most one call per run
   * (Step 23 §10: "one real call only"). */
  realCallCount: 0 | 1;
  entry: CachedBriefingSynthesis;
}

export async function runBriefingSynthesisEvaluation(
  evidence: BriefingEvidenceItem[],
  options: RunBriefingSynthesisOptions
): Promise<RunBriefingSynthesisResult> {
  const { provider, cacheDir = BRIEFING_SYNTHESIS_CACHE_DIR, force = false } = options;
  const evidenceHash = computeEvidenceHash(evidence, provider.model, BRIEFING_SYNTHESIS_PROMPT_VERSION);

  const cached = force ? null : await readCachedBriefingSynthesis(evidenceHash, cacheDir);
  if (cached) {
    return { cacheHit: true, realCallCount: 0, entry: cached };
  }

  const startedAt = Date.now();
  const { output, usage } = await provider.synthesize(evidence);
  const latencyMs = Date.now() - startedAt;
  const estimatedCostUsd = estimateCostUsd(provider.model, usage);
  const groundingIssues = validateBriefingSynthesisGrounding(output, evidence);

  const entry: CachedBriefingSynthesis = {
    evidenceHash,
    model: provider.model,
    promptVersion: BRIEFING_SYNTHESIS_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    output,
    usage,
    estimatedCostUsd,
    latencyMs,
    groundingIssues,
  };
  await writeCachedBriefingSynthesis(entry, cacheDir);

  return { cacheHit: false, realCallCount: 1, entry };
}

import type { ProviderUsage } from "@/lib/ai/types";

/**
 * Manually-maintained pricing table — there is no live pricing API, so
 * this can silently go stale. Every entry MUST carry its own source and
 * verification date; `estimateCostUsd` returns `null` (never a guessed
 * number) for any model not listed here. When adding an entry, verify
 * against the provider's own pricing page and update `asOf`.
 */
interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerMillionUsd: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillionUsd: number;
  /** Where this was verified. */
  source: string;
  /** Date (YYYY-MM-DD) this row was last confirmed against the source. */
  asOf: string;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 5,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    asOf: "2026-09-09",
  },
  "gpt-5.6-luna": {
    inputPerMillionUsd: 0.2,
    outputPerMillionUsd: 1.2,
    source: "https://developers.openai.com/api/docs/pricing",
    asOf: "2026-09-09",
  },
  "gpt-5.6-terra": {
    inputPerMillionUsd: 2.0,
    outputPerMillionUsd: 12.0,
    source: "https://developers.openai.com/api/docs/pricing",
    asOf: "2026-09-09",
  },
};

/**
 * Returns an estimated USD cost for one call, or `null` when either the
 * model has no verified pricing entry or the provider didn't report
 * complete usage. Never fabricates a number — an "unknown" cost in a
 * report is more honest than a wrong one.
 */
export function estimateCostUsd(model: string, usage: ProviderUsage | undefined): number | null {
  if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const pricing = PRICING[model];
  if (!pricing) return null;

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillionUsd;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
  return inputCost + outputCost;
}

export function getPricingSource(model: string): { source: string; asOf: string } | null {
  const pricing = PRICING[model];
  return pricing ? { source: pricing.source, asOf: pricing.asOf } : null;
}

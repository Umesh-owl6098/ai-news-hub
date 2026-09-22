/**
 * Manual/dev-only trigger for AI enrichment. There is deliberately no
 * public HTTP route that runs this — anything that can spend API money
 * stays behind an explicit local command, not an endpoint.
 *
 *   npm run ai:enrich -- --limit 5
 *   npm run ai:enrich -- --limit 3 --source github
 *   npm run ai:enrich -- --dry-run --limit 10        (0 model calls, 0 DB writes)
 *   npm run ai:enrich -- --force --limit 3            (re-spends credits on current items)
 *
 * Normal run vs. --force (Step 16): a normal run already reconsiders
 * completed Hacker News items whose cached discussion context is stale —
 * it refreshes that context (a Hacker News call) and infers again (an
 * OpenAI call) ONLY if the refreshed content actually changed the input
 * hash. `--force` is a different, stronger thing: it re-runs inference on
 * every recent item unconditionally, whether or not anything changed. Use
 * a normal run to keep HN context current cheaply; use `--force` only
 * when you intentionally want to re-spend credits regardless of content.
 *
 * Loads .env.local / .env the same way `next dev` would, since running
 * via `tsx` outside Next gets none of that for free.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // File doesn't exist — fine, env may already be set another way
    // (shell export, CI secret, etc).
  }
}

import {
  enrichRecentItems,
  previewEligibleCandidates,
  DEFAULT_BATCH_LIMIT,
  MAX_BATCH_LIMIT,
} from "@/lib/ai/enrichmentService";
import { getAiProvider } from "@/lib/ai/provider";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { isDatabaseConfigured } from "@/db";
import type { SourceType } from "@/types/feed";

const VALID_SOURCE_TYPES: readonly SourceType[] = ["news", "paper", "github", "hackernews", "discussion"];

function parseArgs(argv: string[]): { limit: number; source?: SourceType; dryRun: boolean; force: boolean } {
  let limit = DEFAULT_BATCH_LIMIT;
  let source: SourceType | undefined;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit" || arg === "-l") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      // Malformed/out-of-range CLI input falls back to the safe default
      // rather than propagating NaN/negative/huge values further down —
      // enrichRecentItems clamps too, but a script should fail predictably.
      limit = Number.isFinite(value) && value > 0 ? value : DEFAULT_BATCH_LIMIT;
    } else if (arg.startsWith("--limit=")) {
      const value = Number.parseInt(arg.slice("--limit=".length), 10);
      limit = Number.isFinite(value) && value > 0 ? value : DEFAULT_BATCH_LIMIT;
    } else if (arg === "--source" || arg === "-s") {
      const value = argv[++i];
      if (VALID_SOURCE_TYPES.includes(value as SourceType)) source = value as SourceType;
    } else if (arg.startsWith("--source=")) {
      const value = arg.slice("--source=".length);
      if (VALID_SOURCE_TYPES.includes(value as SourceType)) source = value as SourceType;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    }
  }

  return { limit, source, dryRun, force };
}

function printStatusHeader(sourceType: SourceType | undefined) {
  const provider = getAiProvider();
  console.log("AI provider:", provider ? `configured (${provider.name})` : "not configured");
  if (provider) console.log("Model:", provider.model);
  console.log("Prompt version:", PROMPT_VERSION);
  if (sourceType) console.log("Source filter:", sourceType);
  console.log("");
}

function formatUsd(value: number | null): string {
  if (value === null) return "cost unknown (no verified pricing for this model)";
  return `$${value.toFixed(5)}`;
}

async function runDryRun(limit: number, source: SourceType | undefined, force: boolean) {
  console.log(`Dry run (limit=${limit}${source ? `, source=${source}` : ""}${force ? ", force" : ""}) — 0 model calls, 0 DB writes.\n`);
  const { providerConfigured, items } = await previewEligibleCandidates({ limit, sourceType: source, force });

  if (items.length === 0) {
    console.log("No candidate items found for this filter.");
    return;
  }

  for (const item of items) {
    const status = item.currentStatus ?? "never enriched";
    const cache = item.cacheCurrent ? "cache current" : "cache stale/missing";
    const action =
      item.wouldCallProvider === "uncertain"
        ? "WOULD CHECK HN (uncertain)"
        : item.wouldCallProvider
          ? "WOULD CALL PROVIDER"
          : "would skip";
    console.log(`  [${action.padEnd(27)}] ${item.sourceKey}`);
    console.log(`      "${item.title}" — ${item.sourceName}`);
    if (item.candidateKind === "stale_hn_context") {
      console.log(
        `      status: ${status}, stale/missing HN discussion context — would refresh from Hacker News and ` +
          `call the model only if that changes the input`
      );
    } else {
      console.log(`      status: ${status}, ${cache}`);
    }
  }

  console.log("");
  console.log(`${items.length} item(s) previewed. Provider configured: ${providerConfigured}.`);
  console.log("No provider was called and no database row was modified.");
}

async function main() {
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL is not set — nothing to enrich without persisted feed items.");
    process.exitCode = 1;
    return;
  }

  const { limit, source, dryRun, force } = parseArgs(process.argv.slice(2));
  printStatusHeader(source);

  if (limit > MAX_BATCH_LIMIT) {
    console.log(`Requested limit ${limit} exceeds the max batch size (${MAX_BATCH_LIMIT}) — clamping.`);
  }

  if (dryRun) {
    await runDryRun(limit, source, force);
    return;
  }

  if (force) {
    console.log(
      "⚠️  --force is set: this reprocesses items even if their cached enrichment is current, " +
        "which spends real API credits on content that wouldn't otherwise be re-sent. " +
        `Still bounded to ${MAX_BATCH_LIMIT} items max.\n`
    );
  }

  console.log(`Running AI enrichment (limit=${limit}${source ? `, source=${source}` : ""}${force ? ", force" : ""})...`);
  const result = await enrichRecentItems({ limit, sourceType: source, force });

  if (!result.providerConfigured) {
    console.log("No AI provider is configured (ANTHROPIC_API_KEY is unset) — nothing was called. This is expected, not an error.");
    return;
  }

  if (result.outcomes.length === 0) {
    console.log("No eligible items found — everything already has a current enrichment. Use --force to override, or --dry-run to preview.");
    return;
  }

  const counts: Record<string, number> = {};
  for (const outcome of result.outcomes) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
    if (outcome.status === "failed") {
      console.log(`  failed           ${outcome.sourceKey} (${outcome.errorCode})`);
    } else if (outcome.status === "completed") {
      const usage = outcome.usage
        ? `in=${outcome.usage.inputTokens ?? "?"} out=${outcome.usage.outputTokens ?? "?"}`
        : "usage unavailable";
      console.log(
        `  completed        ${outcome.sourceKey} (${outcome.latencyMs}ms, ${usage}, ${formatUsd(outcome.estimatedCostUsd)})`
      );
    } else {
      console.log(`  ${outcome.status.padEnd(16)} ${outcome.sourceKey}`);
    }
  }

  console.log("---");
  console.log(Object.entries(counts).map(([status, count]) => `${status}: ${count}`).join(", "));
}

main().catch((error) => {
  console.error("ai:enrich failed:", error);
  process.exitCode = 1;
});

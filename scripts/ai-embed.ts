/**
 * Manual/dev-only trigger for semantic embedding generation (Step 17).
 * There is deliberately no public HTTP route that runs this — anything
 * that can spend API money stays behind an explicit local command.
 *
 *   npm run ai:embed -- --limit 20
 *   npm run ai:embed -- --limit 10 --source github
 *   npm run ai:embed -- --dry-run --limit 50        (0 embedding calls, 0 DB writes)
 *
 * Standing requirement: this script never chooses an embedding model. If
 * `OPENAI_EMBEDDING_MODEL` is not set in the environment, every run
 * (including a normal, non-dry-run invocation) is a safe no-op — exactly
 * like running `ai:enrich` with no AI provider configured.
 *
 * Loads .env.local / .env the same way `next dev` would, since running
 * via `tsx` outside Next gets none of that for free.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // File doesn't exist — fine, env may already be set another way.
  }
}

import {
  embedRecentItems,
  previewEmbeddingCandidates,
  DEFAULT_EMBED_BATCH_LIMIT,
  MAX_EMBED_BATCH_LIMIT,
} from "@/lib/ai/embeddingService";
import { getEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import { EMBEDDING_SCHEMA_VERSION } from "@/lib/ai/semanticDocument";
import { isDatabaseConfigured } from "@/db";
import type { SourceType } from "@/types/feed";

const VALID_SOURCE_TYPES: readonly SourceType[] = ["news", "paper", "github", "hackernews", "discussion"];

function parseArgs(argv: string[]): { limit: number; source?: SourceType; dryRun: boolean } {
  let limit = DEFAULT_EMBED_BATCH_LIMIT;
  let source: SourceType | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit" || arg === "-l") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      limit = Number.isFinite(value) && value > 0 ? value : DEFAULT_EMBED_BATCH_LIMIT;
    } else if (arg.startsWith("--limit=")) {
      const value = Number.parseInt(arg.slice("--limit=".length), 10);
      limit = Number.isFinite(value) && value > 0 ? value : DEFAULT_EMBED_BATCH_LIMIT;
    } else if (arg === "--source" || arg === "-s") {
      const value = argv[++i];
      if (VALID_SOURCE_TYPES.includes(value as SourceType)) source = value as SourceType;
    } else if (arg.startsWith("--source=")) {
      const value = arg.slice("--source=".length);
      if (VALID_SOURCE_TYPES.includes(value as SourceType)) source = value as SourceType;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { limit, source, dryRun };
}

function printStatusHeader(sourceType: SourceType | undefined) {
  const provider = getEmbeddingProvider();
  console.log("Embedding provider:", provider ? `configured (${provider.name})` : "not configured");
  if (provider) console.log("Embedding model:", provider.model);
  console.log("Embedding schema version:", EMBEDDING_SCHEMA_VERSION);
  if (sourceType) console.log("Source filter:", sourceType);
  if (!provider) {
    console.log(
      "\nOPENAI_EMBEDDING_MODEL is not set. This is intentional: Step 17 never chooses an\n" +
        "embedding model automatically. Set OPENAI_EMBEDDING_MODEL once a model has been\n" +
        "explicitly selected, then re-run this command."
    );
  }
  console.log("");
}

async function runDryRun(limit: number, source: SourceType | undefined) {
  console.log(`Dry run (limit=${limit}${source ? `, source=${source}` : ""}) — 0 embedding calls, 0 DB writes.\n`);
  const { providerConfigured, items } = await previewEmbeddingCandidates({ limit, sourceType: source });

  if (items.length === 0) {
    console.log("No candidate items found for this filter.");
    return;
  }

  for (const item of items) {
    const action = item.wouldEmbed ? "WOULD EMBED" : "would skip";
    console.log(`  [${action.padEnd(12)}] ${item.sourceKey}`);
    console.log(`      "${item.title}" — ${item.sourceName}`);
    console.log(`      cache: ${item.cacheCurrent ? "current" : "stale/missing"}`);
  }

  console.log("");
  console.log(`${items.length} item(s) previewed. Provider configured: ${providerConfigured}.`);
  console.log("No provider was called and no database row was modified.");
}

async function main() {
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL is not set — nothing to embed without persisted feed items.");
    process.exitCode = 1;
    return;
  }

  const { limit, source, dryRun } = parseArgs(process.argv.slice(2));
  printStatusHeader(source);

  if (limit > MAX_EMBED_BATCH_LIMIT) {
    console.log(`Requested limit ${limit} exceeds the max batch size (${MAX_EMBED_BATCH_LIMIT}) — clamping.`);
  }

  if (dryRun) {
    await runDryRun(limit, source);
    return;
  }

  console.log(`Running embedding generation (limit=${limit}${source ? `, source=${source}` : ""})...`);
  const result = await embedRecentItems({ limit, sourceType: source });

  if (!result.providerConfigured) {
    console.log("No embedding provider is configured (OPENAI_EMBEDDING_MODEL is unset) — nothing was called. This is expected, not an error.");
    return;
  }

  if (result.outcomes.length === 0) {
    console.log("No eligible items found — everything already has a current embedding. Use --dry-run to preview.");
    return;
  }

  const counts: Record<string, number> = {};
  for (const outcome of result.outcomes) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
    if (outcome.status === "failed") {
      console.log(`  failed    ${outcome.sourceKey} (${outcome.errorCode})`);
    } else {
      const usage = outcome.usage?.inputTokens !== undefined ? `in=${outcome.usage.inputTokens}` : "usage unavailable";
      console.log(`  embedded  ${outcome.sourceKey} (${outcome.latencyMs}ms, ${usage})`);
    }
  }

  console.log("---");
  console.log(Object.entries(counts).map(([status, count]) => `${status}: ${count}`).join(", "));
}

main().catch((error) => {
  console.error("ai:embed failed:", error);
  process.exitCode = 1;
});

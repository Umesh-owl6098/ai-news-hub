/**
 * Concise, secret-free AI status snapshot — dev-only observability, not a
 * dashboard. Read-only: makes no provider calls and no database writes.
 *
 *   npm run ai:status
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // No such file — fine.
  }
}

import { getAiProvider } from "@/lib/ai/provider";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { HN_CONTEXT_TTL_MS } from "@/lib/ai/hnContextCache";
import { isDatabaseConfigured } from "@/db";
import { getEnrichmentStatusCounts, getHnContextCacheStats } from "@/db/repository";

async function main() {
  const provider = getAiProvider();
  console.log("AI provider:  ", provider ? `configured (${provider.name})` : "not configured");
  if (provider) console.log("Model:        ", provider.model);
  console.log("Prompt version:", PROMPT_VERSION);
  console.log("");

  if (!isDatabaseConfigured()) {
    console.log("DATABASE_URL is not set — no persisted enrichment data to report.");
    return;
  }

  const counts = await getEnrichmentStatusCounts();
  const total = counts.pending + counts.processing + counts.completed + counts.failed;
  console.log(`Enrichment rows: ${total} total`);
  console.log(`  completed:  ${counts.completed}`);
  console.log(`  pending:    ${counts.pending}`);
  console.log(`  processing: ${counts.processing}`);
  console.log(`  failed:     ${counts.failed}`);
  console.log("");

  // Aggregate counts only — never comment/story text, never a prompt. The
  // four rows below always sum to `eligible HN feed items` (Step 16: a
  // real column distinguishes each state, never a sentinel).
  const hn = await getHnContextCacheStats(HN_CONTEXT_TTL_MS / 1000);
  console.log(`Hacker News context cache (TTL ${HN_CONTEXT_TTL_MS / 3_600_000}h):`);
  console.log(`  eligible HN feed items:        ${hn.eligibleHnFeedItems}`);
  console.log(`  fresh cached context:          ${hn.freshContextRows}`);
  console.log(`  stale cached context:          ${hn.staleContextRows} (due for a refresh check)`);
  console.log(`  confirmed no usable context:   ${hn.noUsableContextRows} (HN responded, nothing there)`);
  console.log(`  never attempted:               ${hn.neverAttemptedRows} (no cache row yet)`);
  console.log(`  most recent refresh:           ${hn.mostRecentRefresh ? hn.mostRecentRefresh.toISOString() : "never"}`);
}

main().catch((error) => {
  console.error("ai:status failed:", error);
  process.exitCode = 1;
});

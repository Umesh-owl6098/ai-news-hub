/**
 * Step 12 — bounded, one-off Luna vs Terra quality comparison. This is
 * NOT a second general-purpose evaluator: it reuses the production
 * enrichment input-builder, hash, schema, and pricing modules, and only
 * adds the comparison-specific bits (a fixed item list, blind A/B
 * labeling). Every artifact this writes lives under
 * artifacts/ai-evaluation/ (already gitignored) and is fully separate
 * from the production `article_enrichments` table — Terra is never
 * persisted there, and Luna rows are only ever read, never overwritten.
 *
 *   npm run ai:compare
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // No such file — fine.
  }
}

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { getFeedItemForEnrichment, getEnrichmentByFeedItemId } from "@/db/repository";
import { toEnrichmentInput } from "@/lib/ai/enrichmentService";
import { computeInputHash } from "@/lib/ai/hash";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { createOpenAiProvider } from "@/lib/ai/openaiProvider";
import { estimateCostUsd } from "@/lib/ai/pricing";
import type { ArticleEnrichmentResult, ProviderUsage } from "@/lib/ai/types";

const LUNA_MODEL = "gpt-5.6-luna";
const TERRA_MODEL = "gpt-5.6-terra";
const MAX_ITEMS = 12;
const REPORT_DIR = path.join(process.cwd(), "artifacts", "ai-evaluation");

// Sparse/rich classification criterion (documented, applied BEFORE any
// output was read): the character length of the `summary` field actually
// sent to the model. Measured directly from feed_items on 2026-09-10:
// every sparse candidate was <= 33 chars (several are fixed placeholder
// strings like "Discussion thread on Hacker News."), every rich candidate
// was >= 109 chars (real abstracts/publisher copy). The cutoff of 50 sits
// in the wide, unambiguous gap between those two clusters.
const SPARSE_THRESHOLD_CHARS = 50;

/**
 * Fixed, deterministic 12-item comparison set: all 8 items from the Step
 * 11 evaluation whose summary field fell below the sparse threshold,
 * plus 4 rich-metadata controls chosen for source-family diversity
 * (2 arXiv, 1 OpenAI, 1 DeepMind). Reuses Step 11's exact dataset —
 * no new selection logic, no cherry-picking after the fact.
 */
const COMPARISON_SOURCE_KEYS = [
  // sparse (measured summary length in parentheses)
  "hn:49638353", // 33
  "hn:49637435", // 33
  "hn:49637395", // 33
  "rss:huggingface:https://huggingface.co/blog/ibm-research/ibm-releases-sota-granite-time-series", // 20
  "rss:huggingface:https://huggingface.co/blog/MultiverseComputingCAI/safety-for-whom", // 20
  "rss:deepmind:https://deepmind.google/blog/introducing-weathernext-3-our-most-advanced-and-accurate-global-weather-ai-model/", // 20
  "rss:google-research:https://research.google/blog/transfer-learning-for-genomic-prediction-in-underrepresented-populations/", // 15
  "rss:google-research:https://research.google/blog/a-connectomics-milestone-mapping-the-complete-male-fruit-fly-brain/", // 15
  // rich controls
  "arxiv:2609.10540", // 1695
  "arxiv:2609.10539", // 1448
  "rss:openai:https://openai.com/index/paul-christiano-joins-openai-foundation-board", // 148
  "rss:deepmind:https://deepmind.google/blog/alphagenome-atlas-a-predictive-map-of-every-possible-dna-letter-change-in-the-human-genome/", // 109
].slice(0, MAX_ITEMS);

interface ModelRun {
  source: "cached_luna" | "fresh_call";
  output: ArticleEnrichmentResult;
  usage?: ProviderUsage;
  latencyMs: number | null;
  estimatedCostUsd: number | null;
}

interface ComparisonItem {
  sourceKey: string;
  title: string;
  sourceName: string;
  summaryLength: number;
  band: "sparse" | "rich";
  luna: ModelRun;
  terra: ModelRun;
}

function assignLabel(sourceKey: string): "luna_is_A" | "luna_is_B" {
  const digest = createHash("sha256").update(sourceKey).digest("hex");
  return parseInt(digest.slice(0, 8), 16) % 2 === 0 ? "luna_is_A" : "luna_is_B";
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not configured — cannot run a real model comparison.");
    process.exitCode = 1;
    return;
  }

  const lunaProvider = createOpenAiProvider(apiKey, LUNA_MODEL);
  const terraProvider = createOpenAiProvider(apiKey, TERRA_MODEL);

  const items: ComparisonItem[] = [];
  let terraCallCount = 0;
  let lunaCallCount = 0;

  for (const sourceKey of COMPARISON_SOURCE_KEYS) {
    const item = await getFeedItemForEnrichment(sourceKey);
    if (!item) {
      console.error(`SKIPPING ${sourceKey}: not found in the database (was it re-ingested/changed?)`);
      continue;
    }

    const input = toEnrichmentInput(item);
    const inputHash = computeInputHash(input, PROMPT_VERSION);
    const summaryLength = item.summary.length;
    const band: "sparse" | "rich" = summaryLength < SPARSE_THRESHOLD_CHARS ? "sparse" : "rich";

    // --- Luna: reuse the existing production row if it's an exact match ---
    const existing = await getEnrichmentByFeedItemId(item.feedItemId);
    let luna: ModelRun;
    if (
      existing?.status === "completed" &&
      existing.inputHash === inputHash &&
      existing.summary &&
      existing.topics &&
      existing.relevanceScore !== null
    ) {
      luna = {
        source: "cached_luna",
        // Cast is safe: these topics were already Zod-validated against
        // the exact same taxonomy when originally persisted (see
        // markEnrichmentCompleted / enrichmentOutputSchema).
        output: {
          summary: existing.summary,
          topics: existing.topics as ArticleEnrichmentResult["topics"],
          relevanceScore: existing.relevanceScore,
        },
        usage: undefined,
        latencyMs: null,
        estimatedCostUsd: null,
      };
    } else {
      console.log(`No current Luna cache for ${sourceKey} — making a fresh Luna call.`);
      const startedAt = Date.now();
      const result = await lunaProvider.enrichArticle(input);
      lunaCallCount++;
      luna = {
        source: "fresh_call",
        output: result.output,
        usage: result.usage,
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd: estimateCostUsd(LUNA_MODEL, result.usage),
      };
    }

    // --- Terra: always a fresh call, never persisted to article_enrichments ---
    const terraStartedAt = Date.now();
    const terraResult = await terraProvider.enrichArticle(input);
    terraCallCount++;
    const terra: ModelRun = {
      source: "fresh_call",
      output: terraResult.output,
      usage: terraResult.usage,
      latencyMs: Date.now() - terraStartedAt,
      estimatedCostUsd: estimateCostUsd(TERRA_MODEL, terraResult.usage),
    };

    items.push({
      sourceKey,
      title: item.title,
      sourceName: item.sourceName,
      summaryLength,
      band,
      luna,
      terra,
    });

    console.log(`done: ${sourceKey} (${band}) — luna:${luna.source} terra:fresh_call`);
  }

  await mkdir(REPORT_DIR, { recursive: true });

  // Raw (unblinded) data — for the final report and post-scoring reveal.
  await writeFile(path.join(REPORT_DIR, "luna-vs-terra-raw.json"), JSON.stringify({ items, terraCallCount, lunaCallCount }, null, 2), "utf8");

  // Blind scoring sheet: labels A/B only, no model names, shuffled per-item.
  const mapping: Record<string, "luna_is_A" | "luna_is_B"> = {};
  const blindLines: string[] = [
    "# Luna vs Terra — Blind Comparison Sheet",
    "",
    "Model identities are hidden. Score each output on the existing rubric",
    "(factuality 0-2, usefulness 0-2, topic correctness 0-2) using ONLY the",
    "supplied source metadata as ground truth. Do not guess which model is",
    "which. Fill Preferred (A/B/tie) and Reason after scoring both.",
    "",
  ];
  for (const item of items) {
    const label = assignLabel(item.sourceKey);
    mapping[item.sourceKey] = label;
    const [first, second] = label === "luna_is_A" ? [item.luna, item.terra] : [item.terra, item.luna];
    blindLines.push(`## ${item.sourceKey} (${item.band}, summary length ${item.summaryLength})`);
    blindLines.push(`**Title:** ${item.title} — ${item.sourceName}`);
    blindLines.push("");
    blindLines.push(`**Output A**`);
    blindLines.push(`- Summary: ${first.output.summary}`);
    blindLines.push(`- Topics: ${first.output.topics.join(", ")}`);
    blindLines.push(`- Relevance: ${first.output.relevanceScore}`);
    blindLines.push("");
    blindLines.push(`**Output B**`);
    blindLines.push(`- Summary: ${second.output.summary}`);
    blindLines.push(`- Topics: ${second.output.topics.join(", ")}`);
    blindLines.push(`- Relevance: ${second.output.relevanceScore}`);
    blindLines.push("");
    blindLines.push(
      "| A factuality | A usefulness | B factuality | B usefulness | Topic correctness (A/B) | Preferred (A/B/tie) | Reason |"
    );
    blindLines.push("| --- | --- | --- | --- | --- | --- | --- |");
    blindLines.push("|  |  |  |  |  |  |  |");
    blindLines.push("");
  }
  await writeFile(path.join(REPORT_DIR, "luna-vs-terra-blind.md"), blindLines.join("\n"), "utf8");

  // Secret mapping — do not open until scoring above is complete.
  await writeFile(path.join(REPORT_DIR, "luna-vs-terra-mapping.json"), JSON.stringify(mapping, null, 2), "utf8");

  console.log(`\n${items.length} items compared. Terra calls: ${terraCallCount}. Fresh Luna calls: ${lunaCallCount} (cached: ${items.length - lunaCallCount}).`);
  console.log("Blind sheet: artifacts/ai-evaluation/luna-vs-terra-blind.md");
  console.log("Score the blind sheet BEFORE opening luna-vs-terra-mapping.json.");
}

main().catch((error) => {
  console.error("ai:compare failed:", error);
  process.exitCode = 1;
});

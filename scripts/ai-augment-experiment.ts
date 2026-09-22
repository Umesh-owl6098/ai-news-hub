/**
 * Step 13 — controlled input-quality A/B experiment: does supplying real
 * Hacker News discussion context (official Firebase API only) improve
 * enrichment usefulness for stories whose own text is a placeholder?
 *
 * Same model (gpt-5.6-luna), same prompt version, same schema for both
 * sides — the only independent variable is the presence of sourceContext.
 * Baseline outputs are reused read-only from the existing (Step 11/12)
 * `article_enrichments` rows; augmented calls are always fresh and are
 * NEVER persisted to that table (this stays an evaluation-only artifact,
 * per Step 13 §4).
 *
 *   npm run ai:augment
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
import { fetchHnDiscussionContext } from "@/lib/ai/hnContext";
import type { ArticleEnrichmentInput, ArticleEnrichmentResult, ProviderUsage } from "@/lib/ai/types";

const MODEL = "gpt-5.6-luna";
const MAX_NEW_CALLS = 8;
const REPORT_DIR = path.join(process.cwd(), "artifacts", "ai-evaluation");

// The exact Step 12 sparse Hacker News items (source key -> HN numeric story id).
const HN_SPARSE_ITEMS: Array<{ sourceKey: string; storyId: number }> = [
  { sourceKey: "hn:49638353", storyId: 49638353 },
  { sourceKey: "hn:49637435", storyId: 49637435 },
  { sourceKey: "hn:49637395", storyId: 49637395 },
];

// The Step 12 sparse RSS/news items — checked here only to honestly
// record why they're excluded from the real-call experiment (see
// Step 13 §3): none of the 4 publisher feeds provide a content:encoded
// or richer Atom <content> field for ANY item (confirmed by inspecting
// full raw feed payloads, not just these 5), so there is no
// already-fetched richer text to extract without webpage scraping,
// which is explicitly out of scope this milestone.
const RSS_SPARSE_ITEMS_WITH_NO_ADDITIONAL_CONTEXT = [
  "rss:huggingface:https://huggingface.co/blog/ibm-research/ibm-releases-sota-granite-time-series",
  "rss:huggingface:https://huggingface.co/blog/MultiverseComputingCAI/safety-for-whom",
  "rss:deepmind:https://deepmind.google/blog/introducing-weathernext-3-our-most-advanced-and-accurate-global-weather-ai-model/",
  "rss:google-research:https://research.google/blog/transfer-learning-for-genomic-prediction-in-underrepresented-populations/",
  "rss:google-research:https://research.google/blog/a-connectomics-milestone-mapping-the-complete-male-fruit-fly-brain/",
];

interface Side {
  output: ArticleEnrichmentResult;
  usage?: ProviderUsage;
  latencyMs: number | null;
  estimatedCostUsd: number | null;
  contextLength: number;
  source: "cached_baseline" | "fresh_call";
}

interface ComparisonItem {
  sourceKey: string;
  title: string;
  sourceName: string;
  hnApiRequestCount: number;
  baseline: Side;
  augmented: Side;
}

function assignLabel(sourceKey: string): "baseline_is_A" | "baseline_is_B" {
  const digest = createHash("sha256").update(sourceKey).digest("hex");
  return parseInt(digest.slice(0, 8), 16) % 2 === 0 ? "baseline_is_A" : "baseline_is_B";
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not configured — cannot run a real input-augmentation experiment.");
    process.exitCode = 1;
    return;
  }

  console.log("RSS/news sparse items excluded from real calls (no additional feed context found):");
  for (const key of RSS_SPARSE_ITEMS_WITH_NO_ADDITIONAL_CONTEXT) console.log(`  - ${key}`);
  console.log("");

  const provider = createOpenAiProvider(apiKey, MODEL);
  const items: ComparisonItem[] = [];
  let newCallCount = 0;

  for (const { sourceKey, storyId } of HN_SPARSE_ITEMS) {
    if (newCallCount >= MAX_NEW_CALLS) {
      console.log(`Reached the ${MAX_NEW_CALLS}-call bound — stopping before ${sourceKey}.`);
      break;
    }

    const item = await getFeedItemForEnrichment(sourceKey);
    if (!item) {
      console.error(`SKIPPING ${sourceKey}: not found in the database.`);
      continue;
    }

    const baselineInput = toEnrichmentInput(item);
    const baselineHash = computeInputHash(baselineInput, PROMPT_VERSION);

    // --- baseline: reuse the existing Step 11/12 cached Luna row ---
    const existing = await getEnrichmentByFeedItemId(item.feedItemId);
    if (
      !existing ||
      existing.status !== "completed" ||
      existing.inputHash !== baselineHash ||
      !existing.summary ||
      !existing.topics ||
      existing.relevanceScore === null
    ) {
      console.error(`SKIPPING ${sourceKey}: no current cached baseline Luna result to compare against.`);
      continue;
    }
    const baseline: Side = {
      output: {
        summary: existing.summary,
        topics: existing.topics as ArticleEnrichmentResult["topics"],
        relevanceScore: existing.relevanceScore,
      },
      usage: undefined,
      latencyMs: null,
      estimatedCostUsd: null,
      contextLength: baselineInput.summary.length,
      source: "cached_baseline",
    };

    // --- fetch real HN discussion context (official Firebase API only) ---
    const context = await fetchHnDiscussionContext(storyId);
    if (!context) {
      console.log(`SKIPPING ${sourceKey}: no usable HN discussion context available (empty/no comments) — augmented input would be identical to baseline.`);
      continue;
    }
    // 1 request for the story itself + however many comment fetches
    // fetchHnDiscussionContext actually made (bounded to 5 inside it).
    const hnApiRequestCount = 1 + context.commentRequestCount;

    const augmentedInput: ArticleEnrichmentInput = { ...baselineInput, sourceContext: context };

    console.log(`Calling Luna with augmented input for ${sourceKey} (context: ${context.text.length} chars)...`);
    const startedAt = Date.now();
    const result = await provider.enrichArticle(augmentedInput);
    newCallCount++;
    const augmented: Side = {
      output: result.output,
      usage: result.usage,
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd: estimateCostUsd(MODEL, result.usage),
      contextLength: context.text.length,
      source: "fresh_call",
    };

    items.push({
      sourceKey,
      title: item.title,
      sourceName: item.sourceName,
      hnApiRequestCount,
      baseline,
      augmented,
    });
  }

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(
    path.join(REPORT_DIR, "input-augmentation-raw.json"),
    JSON.stringify({ items, newCallCount, rssItemsExcluded: RSS_SPARSE_ITEMS_WITH_NO_ADDITIONAL_CONTEXT }, null, 2),
    "utf8"
  );

  const mapping: Record<string, "baseline_is_A" | "baseline_is_B"> = {};
  const blindLines: string[] = [
    "# Input Augmentation — Blind Comparison Sheet (baseline vs. HN-discussion-augmented)",
    "",
    "Side identities are hidden. Score each output on the existing rubric",
    "(factuality 0-2, usefulness 0-2, topic correctness 0-2, relevance",
    "reasonableness). Watch specifically for commenter speculation being",
    "presented as established fact — that is a factuality penalty",
    "regardless of how useful the added detail seems.",
    "",
  ];
  for (const item of items) {
    const label = assignLabel(item.sourceKey);
    mapping[item.sourceKey] = label;
    const [first, second] = label === "baseline_is_A" ? [item.baseline, item.augmented] : [item.augmented, item.baseline];
    blindLines.push(`## ${item.sourceKey}`);
    blindLines.push(`**Title:** ${item.title} — ${item.sourceName}`);
    blindLines.push("");
    blindLines.push("**Output A**");
    blindLines.push(`- Summary: ${first.output.summary}`);
    blindLines.push(`- Topics: ${first.output.topics.join(", ")}`);
    blindLines.push(`- Relevance: ${first.output.relevanceScore}`);
    blindLines.push("");
    blindLines.push("**Output B**");
    blindLines.push(`- Summary: ${second.output.summary}`);
    blindLines.push(`- Topics: ${second.output.topics.join(", ")}`);
    blindLines.push(`- Relevance: ${second.output.relevanceScore}`);
    blindLines.push("");
    blindLines.push(
      "| A factuality | A usefulness | B factuality | B usefulness | Topic correctness (A/B) | Relevance reasonable (A/B) | Preferred (A/B/tie) | Reason |"
    );
    blindLines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    blindLines.push("|  |  |  |  |  |  |  |  |");
    blindLines.push("");
  }
  await writeFile(path.join(REPORT_DIR, "input-augmentation-blind.md"), blindLines.join("\n"), "utf8");
  await writeFile(path.join(REPORT_DIR, "input-augmentation-mapping.json"), JSON.stringify(mapping, null, 2), "utf8");

  console.log(`\n${items.length} item(s) compared. New real Luna calls: ${newCallCount} (bound: ${MAX_NEW_CALLS}).`);
  console.log("Blind sheet: artifacts/ai-evaluation/input-augmentation-blind.md");
  console.log("Score it BEFORE opening input-augmentation-mapping.json.");
}

main().catch((error) => {
  console.error("ai:augment failed:", error);
  process.exitCode = 1;
});

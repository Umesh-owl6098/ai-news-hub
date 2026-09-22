import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { enrichFeedItem } from "@/lib/ai/enrichmentService";
import { getAiProvider } from "@/lib/ai/provider";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import type { AiProvider, ProviderErrorCode, ProviderUsage } from "@/lib/ai/types";
import type { EvaluationItem } from "@/lib/ai/evaluationSelection";
import { emptyHumanReview, relevanceBandFor, type HumanReview } from "@/lib/ai/evaluationRubric";
import { AI_TOPICS } from "@/lib/ai/taxonomy";

export interface EvaluationResultItem {
  sourceKey: string;
  bucketLabel: string;
  title: string;
  sourceName: string;
  callOutcome: "completed" | "skipped_current" | "failed" | "not_configured";
  errorCode?: ProviderErrorCode;
  summary?: string;
  topics?: string[];
  relevanceScore?: number;
  /** true whenever structured output exists at all — it can only exist
   * here already schema-validated (enforced at the provider-adapter
   * boundary), so this is a structural fact, not a quality judgment. */
  schemaValid: boolean;
  latencyMs?: number;
  usage?: ProviderUsage;
  estimatedCostUsd?: number | null;
  /** Left for a human to fill in after reading the actual output — the
   * harness never scores its own/the model's work. */
  humanReview: HumanReview;
}

export interface EvaluationReport {
  generatedAt: string;
  promptVersion: string;
  providerName: string | null;
  model: string | null;
  itemCount: number;
  realProviderCallCount: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    /** null the moment any contributing call has unknown cost — a
     * partial sum would understate real spend, which is worse than
     * admitting the total is unknown. */
    estimatedCostUsd: number | null;
  };
  results: EvaluationResultItem[];
}

/**
 * Runs the enrichment pipeline's real entry point (`enrichFeedItem`) over
 * a selected set, purely to MEASURE it — this reuses production
 * caching/persistence/retry/error-classification rather than
 * reimplementing any of it, so evaluation runs are never a second code
 * path that could drift from what actually ships. Re-running against
 * unchanged content makes zero new provider calls, same cost guarantee
 * as normal batch enrichment.
 */
export async function runEvaluation(
  items: EvaluationItem[],
  options: { provider?: AiProvider } = {}
): Promise<EvaluationReport> {
  const results: EvaluationResultItem[] = [];
  let realProviderCallCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let costFullyKnown = true;
  const resolvedProvider = options.provider ?? getAiProvider();
  const providerName = resolvedProvider?.name ?? null;
  const model = resolvedProvider?.model ?? null;

  for (const evalItem of items) {
    const outcome = await enrichFeedItem(evalItem.sourceKey, { provider: resolvedProvider ?? undefined });
    const base = {
      sourceKey: evalItem.sourceKey,
      bucketLabel: evalItem.bucketLabel,
      title: evalItem.item.title,
      sourceName: evalItem.item.sourceName,
      humanReview: emptyHumanReview(),
    };

    if (outcome.status === "completed") {
      realProviderCallCount++;
      if (outcome.usage?.inputTokens !== undefined) totalInputTokens += outcome.usage.inputTokens;
      if (outcome.usage?.outputTokens !== undefined) totalOutputTokens += outcome.usage.outputTokens;
      if (outcome.estimatedCostUsd === null) costFullyKnown = false;
      else totalCostUsd += outcome.estimatedCostUsd;

      results.push({
        ...base,
        callOutcome: "completed",
        summary: outcome.output.summary,
        topics: outcome.output.topics,
        relevanceScore: outcome.output.relevanceScore,
        schemaValid: true,
        latencyMs: outcome.latencyMs,
        usage: outcome.usage,
        estimatedCostUsd: outcome.estimatedCostUsd,
      });
    } else if (outcome.status === "skipped_current") {
      results.push({ ...base, callOutcome: "skipped_current", schemaValid: true });
    } else if (outcome.status === "failed") {
      results.push({ ...base, callOutcome: "failed", errorCode: outcome.errorCode, schemaValid: false });
    } else {
      results.push({ ...base, callOutcome: "not_configured", schemaValid: false });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    providerName,
    model,
    itemCount: items.length,
    realProviderCallCount,
    totals: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: costFullyKnown ? totalCostUsd : null,
    },
    results,
  };
}

function mergeReports(a: EvaluationReport, b: EvaluationReport): EvaluationReport {
  const costUsd =
    a.totals.estimatedCostUsd === null || b.totals.estimatedCostUsd === null
      ? null
      : a.totals.estimatedCostUsd + b.totals.estimatedCostUsd;
  return {
    generatedAt: b.generatedAt,
    promptVersion: b.promptVersion,
    providerName: a.providerName ?? b.providerName,
    model: a.model ?? b.model,
    itemCount: a.itemCount + b.itemCount,
    realProviderCallCount: a.realProviderCallCount + b.realProviderCallCount,
    totals: {
      inputTokens: a.totals.inputTokens + b.totals.inputTokens,
      outputTokens: a.totals.outputTokens + b.totals.outputTokens,
      estimatedCostUsd: costUsd,
    },
    results: [...a.results, ...b.results],
  };
}

export interface FullEvaluationResult {
  providerConfigured: boolean;
  /** null = smoke test never ran (no provider configured). */
  smokeTestPassed: boolean | null;
  smokeTestFailureReason?: ProviderErrorCode;
  /** null only when the provider isn't configured or the smoke test
   * failed — a broken/unauthenticated provider must not proceed to spend
   * more calls on the rest of the set (Step 10 §18). */
  report: EvaluationReport | null;
}

/**
 * Orchestrates the real bounded evaluation run: a tiny smoke test first
 * (1-2 items), then — only if it passes — the remainder of the selected
 * set, up to whatever `items` already contains (the caller is
 * responsible for bounding `items` to the 10-20 target from Step 10 §19).
 */
export async function runFullEvaluation(
  items: EvaluationItem[],
  options: { provider?: AiProvider; smokeTestSize?: number } = {}
): Promise<FullEvaluationResult> {
  const provider = options.provider ?? getAiProvider();
  if (!provider) {
    return { providerConfigured: false, smokeTestPassed: null, report: null };
  }

  const smokeSize = Math.min(options.smokeTestSize ?? 2, items.length);
  const smokeItems = items.slice(0, smokeSize);
  const smokeReport = await runEvaluation(smokeItems, { provider });
  const firstFailure = smokeReport.results.find((r) => r.callOutcome === "failed");

  if (firstFailure) {
    return {
      providerConfigured: true,
      smokeTestPassed: false,
      smokeTestFailureReason: firstFailure.errorCode,
      report: smokeReport,
    };
  }

  const remainingItems = items.slice(smokeSize);
  const remainingReport = await runEvaluation(remainingItems, { provider });

  return {
    providerConfigured: true,
    smokeTestPassed: true,
    report: mergeReports(smokeReport, remainingReport),
  };
}

// --- Distribution statistics (Step 10 §23-24) ---------------------------

export interface RelevanceStats {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  byBand: Record<"high" | "medium" | "low", number>;
  bySource: Record<string, { count: number; mean: number }>;
}

export function computeRelevanceStats(report: EvaluationReport): RelevanceStats {
  const scored = report.results.filter(
    (r): r is EvaluationResultItem & { relevanceScore: number } => r.relevanceScore !== undefined
  );
  if (scored.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      byBand: { high: 0, medium: 0, low: 0 },
      bySource: {},
    };
  }

  const scores = scored.map((r) => r.relevanceScore).sort((a, b) => a - b);
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const mid = Math.floor(scores.length / 2);
  const median = scores.length % 2 === 0 ? (scores[mid - 1] + scores[mid]) / 2 : scores[mid];

  const byBand: Record<"high" | "medium" | "low", number> = { high: 0, medium: 0, low: 0 };
  for (const s of scores) byBand[relevanceBandFor(s)]++;

  const bySourceRaw: Record<string, number[]> = {};
  for (const r of scored) {
    (bySourceRaw[r.sourceName] ??= []).push(r.relevanceScore);
  }
  const bySource: Record<string, { count: number; mean: number }> = {};
  for (const [source, values] of Object.entries(bySourceRaw)) {
    bySource[source] = { count: values.length, mean: values.reduce((s, v) => s + v, 0) / values.length };
  }

  return { count: scores.length, min: scores[0], max: scores[scores.length - 1], mean, median, byBand, bySource };
}

export interface TopicStats {
  totalTaggedItems: number;
  frequency: Record<string, number>;
  otherRate: number;
  averageTopicsPerItem: number;
  fourTopicRate: number;
}

export function computeTopicStats(report: EvaluationReport): TopicStats {
  const withTopics = report.results.filter((r): r is EvaluationResultItem & { topics: string[] } => Array.isArray(r.topics));
  const frequency: Record<string, number> = {};
  for (const topic of AI_TOPICS) frequency[topic] = 0;

  let totalTopicCount = 0;
  let fourTopicCount = 0;
  for (const r of withTopics) {
    totalTopicCount += r.topics.length;
    if (r.topics.length >= 4) fourTopicCount++;
    for (const topic of r.topics) frequency[topic] = (frequency[topic] ?? 0) + 1;
  }

  return {
    totalTaggedItems: withTopics.length,
    frequency,
    otherRate: withTopics.length > 0 ? (frequency["Other"] ?? 0) / withTopics.length : 0,
    averageTopicsPerItem: withTopics.length > 0 ? totalTopicCount / withTopics.length : 0,
    fourTopicRate: withTopics.length > 0 ? fourTopicCount / withTopics.length : 0,
  };
}

// --- Report artifacts (Step 10 §10) -------------------------------------

function toMarkdown(report: EvaluationReport, relevance: RelevanceStats, topics: TopicStats): string {
  const lines: string[] = [];
  lines.push("# AI Enrichment Evaluation Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Prompt version: ${report.promptVersion}`);
  lines.push(`Provider: ${report.providerName ?? "n/a"} / Model: ${report.model ?? "n/a"}`);
  lines.push(`Items: ${report.itemCount} — real provider calls: ${report.realProviderCallCount}`);
  lines.push(
    `Tokens: ${report.totals.inputTokens} in / ${report.totals.outputTokens} out — ` +
      `cost: ${report.totals.estimatedCostUsd === null ? "unknown" : `$${report.totals.estimatedCostUsd.toFixed(5)}`}`
  );
  lines.push("");
  lines.push(
    "**Important:** every summary below is generated from normalized *metadata* (title, source, " +
      "feed summary, tags/authors/repo info) — the model never read the full article. This is a " +
      "metadata-based AI summary, not a full-document summary."
  );
  lines.push("");
  lines.push("## Relevance score distribution");
  lines.push("");
  if (relevance.count === 0) {
    lines.push("No scored items.");
  } else {
    lines.push(`count=${relevance.count} min=${relevance.min} max=${relevance.max} mean=${relevance.mean?.toFixed(3)} median=${relevance.median}`);
    lines.push(`bands: high=${relevance.byBand.high} medium=${relevance.byBand.medium} low=${relevance.byBand.low}`);
    lines.push("");
    lines.push("| Source | Count | Mean |");
    lines.push("| --- | --- | --- |");
    for (const [source, s] of Object.entries(relevance.bySource)) {
      lines.push(`| ${source} | ${s.count} | ${s.mean.toFixed(3)} |`);
    }
  }
  lines.push("");
  lines.push("## Topic distribution");
  lines.push("");
  if (topics.totalTaggedItems === 0) {
    lines.push("No tagged items.");
  } else {
    lines.push(`avg topics/item=${topics.averageTopicsPerItem.toFixed(2)}, 4-topic rate=${(topics.fourTopicRate * 100).toFixed(0)}%, "Other" rate=${(topics.otherRate * 100).toFixed(0)}%`);
    lines.push("");
    lines.push("| Topic | Count |");
    lines.push("| --- | --- |");
    for (const [topic, count] of Object.entries(topics.frequency)) {
      if (count > 0) lines.push(`| ${topic} | ${count} |`);
    }
  }
  lines.push("");
  lines.push("## Per-item results (fill in the Human Review columns)");
  lines.push("");
  lines.push("| Source Key | Bucket | Outcome | Summary | Topics | Score | Factuality (0-2) | Usefulness (0-2) | Topic correctness (0-2) | Score reasonable? | Notes |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.results) {
    lines.push(
      `| ${r.sourceKey} | ${r.bucketLabel} | ${r.callOutcome}${r.errorCode ? ` (${r.errorCode})` : ""} | ${(r.summary ?? "").replace(/\|/g, "/")} | ${(r.topics ?? []).join(", ")} | ${r.relevanceScore ?? ""} | | | | | |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Writes both artifacts to disk. Callers decide the directory — the CLI
 * script uses `artifacts/ai-evaluation/`, which is gitignored (see
 * .gitignore) except for a `.gitkeep`: the deterministic selection logic
 * and rubric are code (committed normally); generated provider output is
 * a snapshot of one run against live external content, not something
 * this repo has a real benchmark reason to freeze in git history yet.
 */
export async function writeEvaluationReport(report: EvaluationReport, dir: string): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(dir, { recursive: true });
  const relevance = computeRelevanceStats(report);
  const topics = computeTopicStats(report);

  const jsonPath = path.join(dir, "latest.json");
  const mdPath = path.join(dir, "latest.md");

  await writeFile(jsonPath, JSON.stringify({ report, relevance, topics }, null, 2), "utf8");
  await writeFile(mdPath, toMarkdown(report, relevance, topics), "utf8");

  return { jsonPath, mdPath };
}

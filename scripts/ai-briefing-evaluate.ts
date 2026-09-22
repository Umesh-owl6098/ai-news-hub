/**
 * Step 23 — AI Briefing Synthesis Experiment. EXPERIMENTAL / evaluation
 * only: this compares the existing deterministic `/briefing` (Step 22)
 * against an AI synthesis over exactly the same selected evidence, so a
 * human can judge whether AI synthesis is materially better before any
 * production change is even considered. Nothing here is imported by
 * `/briefing` itself (see the static-analysis regression test).
 *
 *   npm run ai:briefing-evaluate -- --dry-run   (0 model calls, 0 writes)
 *   npm run ai:briefing-evaluate                (1 real call, or a cache
 *                                                 hit if evidence/model/
 *                                                 prompt are unchanged)
 *   npm run ai:briefing-evaluate -- --force     (bypass the cache; spends
 *                                                 a real call even if one
 *                                                 already exists for this
 *                                                 exact evidence)
 *
 * Loads .env.local / .env the same way `next dev` would, since running
 * via `tsx` outside Next gets none of that for free.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // No such file — fine.
  }
}

import path from "node:path";
import { isDatabaseConfigured } from "@/db";
import { getFeedItemsForBriefing } from "@/db/repository";
import { buildBriefing, type BriefingSections } from "@/lib/briefing";
import {
  buildBriefingEvidence,
  computeEvidenceHash,
  type BriefingEvidenceItem,
  type GroundingIssue,
} from "@/lib/ai/briefingSynthesisEvidence";
import { BRIEFING_SYNTHESIS_PROMPT_VERSION, buildBriefingSynthesisPrompt } from "@/lib/ai/briefingSynthesisPrompt";
import { createOpenAiBriefingSynthesisProvider, BriefingSynthesisCallError } from "@/lib/ai/briefingSynthesisProvider";
import type { BriefingSynthesisOutput } from "@/lib/ai/briefingSynthesisSchema";
import { readCachedBriefingSynthesis, BRIEFING_SYNTHESIS_CACHE_DIR, type CachedBriefingSynthesis } from "@/lib/ai/briefingSynthesisCache";
import { runBriefingSynthesisEvaluation } from "@/lib/ai/briefingSynthesisOrchestration";
import { estimateCostUsd, getPricingSource } from "@/lib/ai/pricing";
import { ProviderError } from "@/lib/ai/types";
import {
  GROUNDED_FACTUALITY_SCALE,
  ADDED_USEFULNESS_SCALE,
  CONCISION_SCALE,
  CONNECTION_QUALITY_SCALE,
} from "@/lib/ai/briefingSynthesisRubric";

// Fixed per Step 23 §5 — "Start with gpt-5.6-luna. Do not silently fall
// back to another model. Do not run a multi-model comparison initially."
const MODEL = "gpt-5.6-luna";
const REPORT_DIR = path.join(process.cwd(), "artifacts", "ai-evaluation", "briefing-synthesis");

function parseArgs(argv: string[]): { dryRun: boolean; force: boolean } {
  return { dryRun: argv.includes("--dry-run"), force: argv.includes("--force") };
}

function sectionComposition(evidence: BriefingEvidenceItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of evidence) counts[item.section] = (counts[item.section] ?? 0) + 1;
  return counts;
}

function sourceComposition(evidence: BriefingEvidenceItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of evidence) counts[item.sourceType] = (counts[item.sourceType] ?? 0) + 1;
  return counts;
}

function formatUsd(value: number | null): string {
  return value === null ? "unknown (no verified pricing for this model)" : `$${value.toFixed(6)}`;
}

/** A compact, deterministic-briefing-style rendering of the SAME evidence
 * — side A of the human-evaluation artifact. Frozen-snapshot dates
 * (not "3h ago") so the artifact reads correctly no matter when it's
 * opened, unlike the live `/briefing` page. */
function renderDeterministicSide(sections: BriefingSections): string {
  const lines: string[] = [];
  const renderSection = (title: string, items: typeof sections.topStories) => {
    if (items.length === 0) return;
    lines.push(`### ${title}`, "");
    for (const item of items) {
      const detail =
        item.sourceType === "hackernews"
          ? ` — ${item.score} points, ${item.commentCount} comments`
          : item.sourceType === "github" && typeof item.stars === "number"
            ? ` — ${item.stars} stars`
            : item.sourceType === "paper" && item.tags.length > 0
              ? ` — ${item.tags[0]}`
              : "";
      lines.push(`- **${item.title}** (${item.id}) — ${item.sourceName} · ${item.publishedAt}${detail}`);
    }
    lines.push("");
  };
  renderSection("Top stories", sections.topStories);
  renderSection("Research", sections.research);
  renderSection("Projects", sections.projects);
  renderSection("News & discussion", sections.newsAndDiscussion);
  return lines.join("\n");
}

function renderSynthesisSide(output: BriefingSynthesisOutput): string {
  const lines: string[] = [`**Headline:** ${output.headline}`, "", `**Overview:** ${output.overview}`, "", "### Highlights", ""];
  for (const h of output.highlights) {
    lines.push(`- **[${h.itemId}]** ${h.summary}`);
    if (h.whyItMatters) lines.push(`  - Why it matters: ${h.whyItMatters}`);
  }
  if (output.connections && output.connections.length > 0) {
    lines.push("", "### Connections", "");
    for (const c of output.connections) lines.push(`- [${c.itemIds.join(", ")}] — ${c.observation}`);
  }
  return lines.join("\n");
}

function renderGroundingFlags(issues: GroundingIssue[]): string {
  if (issues.length === 0) return "None.";
  return issues.map((i) => `- **${i.severity.toUpperCase()}**: ${i.message}`).join("\n");
}

function renderReportMarkdown(params: {
  entry: CachedBriefingSynthesis;
  sections: BriefingSections;
  cacheHit: boolean;
  realCallCount: number;
}): string {
  const { entry, sections, cacheHit, realCallCount } = params;
  const pricingSource = getPricingSource(entry.model);
  const lines: string[] = [
    "# AI Briefing Synthesis Experiment — Human Evaluation",
    "",
    `Generated: ${entry.generatedAt}`,
    `Model: ${entry.model}`,
    `Prompt version: ${entry.promptVersion}`,
    `Evidence hash: ${entry.evidenceHash}`,
    `Cache: ${cacheHit ? "HIT (no new call made this run)" : "MISS (fresh call this run)"}`,
    `Real provider calls this run: ${realCallCount}`,
    "",
    "## Cost & Performance",
    "",
    `Tokens: ${entry.usage?.inputTokens ?? "?"} in / ${entry.usage?.outputTokens ?? "?"} out`,
    `Estimated cost: ${formatUsd(entry.estimatedCostUsd)}${pricingSource ? ` (pricing verified ${pricingSource.asOf}, ${pricingSource.source})` : ""}`,
    `Latency: ${entry.latencyMs}ms`,
    "Schema valid: true (Zod-validated; see briefingSynthesisSchema.ts)",
    "",
    "## Automated grounding flags",
    "",
    renderGroundingFlags(entry.groundingIssues),
    "",
    "**Important:** automated checks can only catch structural problems (an unknown item id, an under-specified connection, a number absent from the evidence). They cannot establish that a claim is true — human factuality review below is still required.",
    "",
    "## A. Deterministic briefing (existing production `/briefing`, same evidence)",
    "",
    renderDeterministicSide(sections),
    "## B. AI synthesis (same evidence)",
    "",
    renderSynthesisSide(entry.output),
    "",
    "## Human evaluation rubric",
    "",
    "Score each dimension 0/1/2 by reading A and B above. Do not let the model grade itself.",
    "",
    "| Dimension | Score (0-2) | Notes |",
    "| --- | --- | --- |",
    "| Grounded factuality | | |",
    "| Added usefulness | | |",
    "| Concision | | |",
    "| Connection quality | | |",
    "",
    "Preference: [ ] deterministic only &nbsp;&nbsp; [ ] deterministic + AI synthesis &nbsp;&nbsp; [ ] no preference",
    "",
    "### Scale definitions",
    "",
    "**Grounded factuality** — " + Object.entries(GROUNDED_FACTUALITY_SCALE).reverse().map(([k, v]) => `${k}=${v}`).join("; "),
    "",
    "**Added usefulness** — " + Object.entries(ADDED_USEFULNESS_SCALE).reverse().map(([k, v]) => `${k}=${v}`).join("; "),
    "",
    "**Concision** — " + Object.entries(CONCISION_SCALE).reverse().map(([k, v]) => `${k}=${v}`).join("; "),
    "",
    "**Connection quality** — " + Object.entries(CONNECTION_QUALITY_SCALE).reverse().map(([k, v]) => `${k}=${v}`).join("; "),
    "",
  ];
  return lines.join("\n");
}

async function main() {
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL is not set — the briefing evidence is selected from persisted records, so there's nothing to evaluate.");
    process.exitCode = 1;
    return;
  }

  const { dryRun, force } = parseArgs(process.argv.slice(2));

  console.log("Building the SAME evidence the deterministic /briefing would select...");
  const pool = await getFeedItemsForBriefing();
  const sections = buildBriefing(pool);
  const evidence = buildBriefingEvidence(sections);
  const evidenceHash = computeEvidenceHash(evidence, MODEL, BRIEFING_SYNTHESIS_PROMPT_VERSION);

  console.log(`Evidence: ${evidence.length} item(s)`);
  console.log(`  by section: ${JSON.stringify(sectionComposition(evidence))}`);
  console.log(`  by source type: ${JSON.stringify(sourceComposition(evidence))}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Prompt version: ${BRIEFING_SYNTHESIS_PROMPT_VERSION}`);
  console.log(`Evidence hash: ${evidenceHash}`);

  if (evidence.length === 0) {
    console.log("\nNo evidence available — the deterministic briefing selected nothing (empty corpus, or nothing in the eligible window). Nothing to synthesize.");
    return;
  }

  const cached = force ? null : await readCachedBriefingSynthesis(evidenceHash);

  if (dryRun) {
    const { system, user } = buildBriefingSynthesisPrompt(evidence);
    console.log(`Approximate prompt size: ${system.length + user.length} chars (system=${system.length}, user=${user.length})`);
    console.log(`Cached evaluation output exists: ${cached ? "yes" : "no"}`);
    console.log(`Estimated real provider calls if run now: ${force ? 1 : cached ? 0 : 1}`);
    console.log("\nDry run — 0 model calls, 0 files written.");
    return;
  }

  if (force) {
    console.log("\n⚠️  --force is set: bypassing the cache and spending a real call even if this exact evidence was already evaluated.\n");
  }

  let result: Awaited<ReturnType<typeof runBriefingSynthesisEvaluation>>;
  // A pure cache hit needs no API key at all — re-running unchanged
  // evaluation must make zero additional OpenAI calls (Step 23 §7), and
  // that guarantee shouldn't depend on a key still being present.
  const apiKey = process.env.OPENAI_API_KEY;

  if (!cached) {
    if (!apiKey) {
      console.error("\nOPENAI_API_KEY is not configured — cannot run a real briefing-synthesis experiment.");
      console.error("This is the specific blocker: no other configuration was attempted, no credential was rotated, no retry was made.");
      process.exitCode = 1;
      return;
    }
    console.log(`\nNo cached result for this evidence — calling ${MODEL} once...`);
  } else {
    console.log("\nCache hit for this exact evidence/model/prompt-version combination — reusing it. 0 provider calls made.");
  }

  try {
    // Constructing the provider never itself makes a network call —
    // it's a plain closure over the key/model, safe to build even on
    // the cache-hit path (runBriefingSynthesisEvaluation returns before
    // ever calling .synthesize() when the cache already has an entry).
    const provider = createOpenAiBriefingSynthesisProvider(apiKey ?? "", MODEL);
    result = await runBriefingSynthesisEvaluation(evidence, { provider, force });
  } catch (error) {
    if (error instanceof BriefingSynthesisCallError) {
      // Step 23C §7 — retain and print every safe diagnostic available at
      // the point of failure, even though the call itself failed: which
      // stage it died at, completion status, usage, and a calculated cost
      // from that usage (a failed call can still have spent real tokens).
      console.error(`\nProvider call failed: [${error.code}] ${error.message}`);
      console.error(`  failure stage: ${error.stage}`);
      console.error(`  latency: ${error.latencyMs}ms`);
      if (error.completionStatus) console.error(`  completion status: ${error.completionStatus}`);
      if (error.usage) {
        const cost = estimateCostUsd(MODEL, error.usage);
        console.error(`  usage: in=${error.usage.inputTokens ?? "?"} out=${error.usage.outputTokens ?? "?"} — cost: ${formatUsd(cost)}`);
      } else {
        console.error("  usage: unavailable (failure occurred before a response envelope was received)");
      }
      console.error("Stopping — no retry was attempted, no credential was touched.");
    } else if (error instanceof ProviderError) {
      console.error(`\nProvider call failed: [${error.code}] ${error.message}`);
      console.error("Stopping — no retry was attempted, no credential was touched.");
    } else {
      console.error("\nUnexpected error during the provider call:", error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
    return;
  }

  const { entry, cacheHit, realCallCount } = result;

  if (!cacheHit) {
    console.log(`Call succeeded in ${entry.latencyMs}ms. Cached at: ${path.join(BRIEFING_SYNTHESIS_CACHE_DIR, `${entry.evidenceHash}.json`)}`);
    if (entry.groundingIssues.length > 0) {
      console.log(`Automated grounding flags (${entry.groundingIssues.length}):`);
      for (const issue of entry.groundingIssues) console.log(`  [${issue.severity}] ${issue.message}`);
    } else {
      console.log("Automated grounding checks: no issues flagged.");
    }
  }

  console.log(
    `\nTokens: ${entry.usage?.inputTokens ?? "?"} in / ${entry.usage?.outputTokens ?? "?"} out — cost: ${formatUsd(entry.estimatedCostUsd)}`
  );

  const markdown = renderReportMarkdown({ entry, sections, cacheHit, realCallCount });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, "latest.json");
  const mdPath = path.join(REPORT_DIR, "latest.md");
  await writeFile(jsonPath, JSON.stringify({ entry, evidence }, null, 2), "utf8");
  await writeFile(mdPath, markdown, "utf8");

  console.log(`\nHuman-evaluation artifact written to:\n  ${jsonPath}\n  ${mdPath}`);
  console.log(`(Cache directory: ${BRIEFING_SYNTHESIS_CACHE_DIR})`);
  console.log("\nOpen the Markdown report and fill in the rubric — this experiment does not grade itself.");
}

main().catch((error) => {
  console.error("ai:briefing-evaluate failed:", error);
  process.exitCode = 1;
});

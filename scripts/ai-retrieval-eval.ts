/**
 * Step 17 retrieval evaluation harness — NOT run as part of this
 * milestone (no embedding model is configured yet, see the Step 17 final
 * report). Exists as ready-to-use scaffolding for the evaluation pass
 * that follows model selection.
 *
 * Usage (once OPENAI_EMBEDDING_MODEL is set and the corpus has been
 * embedded via `npm run ai:embed`):
 *
 *   npm run ai:retrieval-eval
 *     Runs the fixed benchmark (evaluation/step17-retrieval-benchmark.json)
 *     against lexical/semantic/hybrid, top 5 each, and writes two files:
 *       evaluation/step17-retrieval-results-blinded.json  (labels A/B/C only)
 *       evaluation/step17-retrieval-results-key.json      (A/B/C -> method)
 *     Judge the blinded file BEFORE opening the key file — that's the
 *     whole point of blinding: a human scoring "A/B/C" for one query at a
 *     time can't unconsciously favor a method they know produced a list.
 *
 *   npm run ai:retrieval-eval -- --score path/to/judgments.json
 *     Given a filled-in judgments file (see JudgmentsFile below), reveals
 *     the key and computes Precision@5, average judged relevance, and
 *     win/tie counts per method — the metrics §14 of the Step 17
 *     instructions requires before any production integration decision.
 *
 * Never grades itself: this script only ever aggregates numbers a human
 * already typed in. It has no dependency on the embedding or enrichment
 * model for scoring.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // File doesn't exist — fine.
  }
}

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runRetrieval, type RetrievalStrategy, type RetrievalFilters } from "@/lib/ai/semanticSearch";
import { isDatabaseConfigured } from "@/db";

const BENCHMARK_PATH = path.join(process.cwd(), "evaluation", "step17-retrieval-benchmark.json");
const BLINDED_OUTPUT_PATH = path.join(process.cwd(), "evaluation", "step17-retrieval-results-blinded.json");
const KEY_OUTPUT_PATH = path.join(process.cwd(), "evaluation", "step17-retrieval-results-key.json");
const RESULTS_PER_METHOD = 5;
const METHODS: readonly RetrievalStrategy[] = ["lexical", "semantic", "hybrid"];
const LABELS = ["A", "B", "C"] as const;

interface BenchmarkQuery {
  id: number;
  category: string;
  query: string;
  filters: RetrievalFilters;
}

interface BenchmarkFile {
  queries: BenchmarkQuery[];
}

/** Deterministic per-query label assignment (not truly random, but not
 * revealing either) — a rotation keyed on the query id, so re-running
 * `--run` after a code fix reproduces the same blinding rather than
 * reshuffling mid-review. */
function labelOrderForQuery(queryId: number): readonly RetrievalStrategy[] {
  const rotation = queryId % METHODS.length;
  return [...METHODS.slice(rotation), ...METHODS.slice(0, rotation)];
}

async function runBenchmark() {
  const benchmark: BenchmarkFile = JSON.parse(readFileSync(BENCHMARK_PATH, "utf-8"));

  const blinded: unknown[] = [];
  const key: Record<number, Record<string, RetrievalStrategy>> = {};

  for (const q of benchmark.queries) {
    const order = labelOrderForQuery(q.id);
    const methodResults = await Promise.all(order.map((method) => runRetrieval(method, q.query, q.filters, RESULTS_PER_METHOD)));

    const labeledResults: Record<string, { title: string; sourceKey: string; sourceName: string }[]> = {};
    key[q.id] = {};
    order.forEach((method, i) => {
      const label = LABELS[i];
      key[q.id][label] = method;
      labeledResults[label] = methodResults[i].map((r) => ({
        title: r.item.title,
        sourceKey: r.item.id,
        sourceName: r.item.sourceName,
      }));
    });

    blinded.push({ id: q.id, category: q.category, query: q.query, filters: q.filters, results: labeledResults });
  }

  writeFileSync(BLINDED_OUTPUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), queries: blinded }, null, 2));
  writeFileSync(KEY_OUTPUT_PATH, JSON.stringify(key, null, 2));

  console.log(`Wrote ${blinded.length} blinded query results to ${BLINDED_OUTPUT_PATH}`);
  console.log(`Wrote the A/B/C -> method key to ${KEY_OUTPUT_PATH}`);
  console.log("\nJudge the blinded file first (rubric: 2 = clearly relevant, 1 = somewhat relevant, 0 = irrelevant).");
  console.log("Do not open the key file until every query has been scored.");
}

interface JudgmentEntry {
  id: number;
  scores: { A: number[]; B: number[]; C: number[] };
}
interface JudgmentsFile {
  judgments: JudgmentEntry[];
}

function scoreBenchmark(judgmentsPath: string) {
  const judgments: JudgmentsFile = JSON.parse(readFileSync(judgmentsPath, "utf-8"));
  const key: Record<string, Record<string, RetrievalStrategy>> = JSON.parse(readFileSync(KEY_OUTPUT_PATH, "utf-8"));

  const totals: Record<RetrievalStrategy, { precisionAt5Sum: number; avgRelevanceSum: number; queries: number }> = {
    lexical: { precisionAt5Sum: 0, avgRelevanceSum: 0, queries: 0 },
    semantic: { precisionAt5Sum: 0, avgRelevanceSum: 0, queries: 0 },
    hybrid: { precisionAt5Sum: 0, avgRelevanceSum: 0, queries: 0 },
  };
  const wins: Record<RetrievalStrategy, number> = { lexical: 0, semantic: 0, hybrid: 0 };
  let ties = 0;

  for (const entry of judgments.judgments) {
    const methodForLabel = key[String(entry.id)];
    const perMethodAvg: Partial<Record<RetrievalStrategy, number>> = {};

    for (const label of LABELS) {
      const method = methodForLabel[label];
      const scores = entry.scores[label] ?? [];
      const relevant = scores.filter((s) => s >= 1).length; // "somewhat relevant" or better counts toward Precision@5
      const precisionAt5 = scores.length > 0 ? relevant / scores.length : 0;
      const avgRelevance = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

      totals[method].precisionAt5Sum += precisionAt5;
      totals[method].avgRelevanceSum += avgRelevance;
      totals[method].queries += 1;
      perMethodAvg[method] = avgRelevance;
    }

    const best = Math.max(...Object.values(perMethodAvg).map((v) => v ?? 0));
    const winners = (Object.keys(perMethodAvg) as RetrievalStrategy[]).filter((m) => perMethodAvg[m] === best);
    if (winners.length > 1) ties++;
    else wins[winners[0]]++;
  }

  console.log("Step 17 retrieval evaluation — aggregate results\n");
  for (const method of METHODS) {
    const t = totals[method];
    if (t.queries === 0) continue;
    console.log(`${method}:`);
    console.log(`  Precision@5 (avg across queries): ${(t.precisionAt5Sum / t.queries).toFixed(3)}`);
    console.log(`  Average judged relevance:         ${(t.avgRelevanceSum / t.queries).toFixed(3)}`);
    console.log(`  Queries where this method won:    ${wins[method]}`);
  }
  console.log(`Ties: ${ties}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--score")) {
    const judgmentsPath = args[args.indexOf("--score") + 1];
    if (!judgmentsPath) {
      console.error("Usage: npm run ai:retrieval-eval -- --score path/to/judgments.json");
      process.exitCode = 1;
      return;
    }
    scoreBenchmark(judgmentsPath);
    return;
  }

  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL is not set — nothing to evaluate without persisted, embedded feed items.");
    process.exitCode = 1;
    return;
  }

  await runBenchmark();
}

main().catch((error) => {
  console.error("ai:retrieval-eval failed:", error);
  process.exitCode = 1;
});

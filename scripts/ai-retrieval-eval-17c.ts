/**
 * Step 17C retrieval evaluation harness — a parallel, independent copy of
 * ai-retrieval-eval.ts pointed at the NEW, more discriminating benchmark
 * (evaluation/step17c-retrieval-benchmark.json). Exists as a separate file
 * specifically so the frozen Step 17/17B benchmark, blinded results, key,
 * and script are never touched by this pass — Step 17B remains an
 * immutable historical evaluation.
 *
 * Reuses the exact same production retrieval functions (runRetrieval,
 * lexicalSearch/semanticSearch/hybridSearch, RRF k=60) — no retrieval
 * logic was changed for Step 17C, only the benchmark and judging tooling.
 *
 *   npm run ai:retrieval-eval-17c
 *     Runs the frozen 26-query Step 17C benchmark, writes:
 *       evaluation/step17c-retrieval-results-blinded.json
 *       evaluation/step17c-retrieval-results-key.json
 *
 *   npm run ai:retrieval-eval-17c -- --score path/to/judgments.json
 *     Computes Precision@5 (fixed denominator), average relevance, score-2
 *     rate, score distribution, returned-count, per-query total relevance,
 *     wins/ties/losses, and NDCG@5. Not run until human judging is
 *     complete — see the Step 17C final report.
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

const BENCHMARK_PATH = path.join(process.cwd(), "evaluation", "step17c-retrieval-benchmark.json");
const BLINDED_OUTPUT_PATH = path.join(process.cwd(), "evaluation", "step17c-retrieval-results-blinded.json");
const KEY_OUTPUT_PATH = path.join(process.cwd(), "evaluation", "step17c-retrieval-results-key.json");
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

function labelOrderForQuery(queryId: number): readonly RetrievalStrategy[] {
  const rotation = queryId % METHODS.length;
  return [...METHODS.slice(rotation), ...METHODS.slice(0, rotation)];
}

async function runBenchmark() {
  const benchmark: BenchmarkFile = JSON.parse(readFileSync(BENCHMARK_PATH, "utf-8"));

  const blinded: unknown[] = [];
  const key: Record<number, Record<string, RetrievalStrategy>> = {};
  let totalReturned = 0;

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
      totalReturned += methodResults[i].length;
    });

    blinded.push({ id: q.id, category: q.category, query: q.query, filters: q.filters, results: labeledResults });
  }

  writeFileSync(BLINDED_OUTPUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), queries: blinded }, null, 2));
  writeFileSync(KEY_OUTPUT_PATH, JSON.stringify(key, null, 2));

  console.log(`Wrote ${blinded.length} blinded query results to ${BLINDED_OUTPUT_PATH}`);
  console.log(`Wrote the A/B/C -> method key to ${KEY_OUTPUT_PATH}`);
  console.log(`Total result cells across all methods/queries: ${totalReturned}`);
  console.log("\nJudge the blinded file first (rubric: 2 = direct/strong, 1 = partial/indirect, 0 = not useful even if AI-related).");
  console.log("Do not open the key file until every scoreable result has been judged.");
}

interface JudgmentEntry {
  id: number;
  scores: { A: number[]; B: number[]; C: number[] };
}
interface JudgmentsFile {
  judgments: JudgmentEntry[];
}

/** NDCG@5 with 0/1/2 grades — standard formula: DCG = sum(rel_i / log2(i+1))
 * for i=1..5 (1-indexed rank), normalized by IDCG (the DCG of the same
 * grades sorted ideally). A method that returns fewer than 5 results is
 * NOT penalized further by NDCG beyond what its own graded list already
 * reflects — NDCG measures ranking quality of what was returned, so it is
 * reported ALONGSIDE Precision@5/returned-count, never as a replacement
 * for the coverage story those already tell. */
function ndcgAt5(scores: number[]): number {
  const dcg = scores.slice(0, 5).reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
  const ideal = [...scores].sort((a, b) => b - a);
  const idcg = ideal.slice(0, 5).reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
  return idcg > 0 ? dcg / idcg : 0;
}

function scoreBenchmark(judgmentsPath: string) {
  const judgments: JudgmentsFile = JSON.parse(readFileSync(judgmentsPath, "utf-8"));
  const key: Record<string, Record<string, RetrievalStrategy>> = JSON.parse(readFileSync(KEY_OUTPUT_PATH, "utf-8"));
  const benchmark: BenchmarkFile = JSON.parse(readFileSync(BENCHMARK_PATH, "utf-8"));
  const categoryByQuery = new Map(benchmark.queries.map((q) => [q.id, q.category]));

  const totals: Record<
    RetrievalStrategy,
    { precisionAt5Sum: number; avgRelevanceSum: number; ndcgSum: number; queries: number; returned: number; dist: Record<number, number> }
  > = {
    lexical: { precisionAt5Sum: 0, avgRelevanceSum: 0, ndcgSum: 0, queries: 0, returned: 0, dist: { 0: 0, 1: 0, 2: 0 } },
    semantic: { precisionAt5Sum: 0, avgRelevanceSum: 0, ndcgSum: 0, queries: 0, returned: 0, dist: { 0: 0, 1: 0, 2: 0 } },
    hybrid: { precisionAt5Sum: 0, avgRelevanceSum: 0, ndcgSum: 0, queries: 0, returned: 0, dist: { 0: 0, 1: 0, 2: 0 } },
  };
  const wins: Record<RetrievalStrategy, number> = { lexical: 0, semantic: 0, hybrid: 0 };
  let ties = 0;
  const categoryTotals: Record<string, typeof totals> = {};

  for (const entry of judgments.judgments) {
    const methodForLabel = key[String(entry.id)];
    const cat = categoryByQuery.get(entry.id) ?? "unknown";
    if (!categoryTotals[cat]) {
      categoryTotals[cat] = JSON.parse(JSON.stringify(totals));
    }

    // Build a clean method -> scores lookup once, so nothing below needs
    // to re-derive "which label was this method" from the key.
    const scoresByMethod: Record<RetrievalStrategy, number[]> = { lexical: [], semantic: [], hybrid: [] };
    for (const label of LABELS) {
      scoresByMethod[methodForLabel[label]] = entry.scores[label] ?? [];
    }

    for (const method of METHODS) {
      const scores = scoresByMethod[method];
      const relevant = scores.filter((s) => s >= 1).length;
      const precisionAt5 = relevant / 5; // fixed denominator — never rewards a short list as if it were a full one
      const avgRelevance = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const ndcg = ndcgAt5(scores);

      for (const bucket of [totals, categoryTotals[cat]]) {
        bucket[method].precisionAt5Sum += precisionAt5;
        bucket[method].ndcgSum += ndcg;
        bucket[method].queries += 1;
        bucket[method].returned += scores.length;
        if (scores.length > 0) bucket[method].avgRelevanceSum += avgRelevance;
        for (const s of scores) bucket[method].dist[s] = (bucket[method].dist[s] ?? 0) + 1;
      }
    }

    // Winner: total graded relevance across top 5; tiebreak on #score-2s, then ranked position.
    const totalRelevance: Record<RetrievalStrategy, number> = {
      lexical: scoresByMethod.lexical.reduce((a, b) => a + b, 0),
      semantic: scoresByMethod.semantic.reduce((a, b) => a + b, 0),
      hybrid: scoresByMethod.hybrid.reduce((a, b) => a + b, 0),
    };
    const maxTotal = Math.max(...METHODS.map((m) => totalRelevance[m]));
    let candidates = METHODS.filter((m) => totalRelevance[m] === maxTotal);
    if (candidates.length > 1) {
      const twoCounts = Object.fromEntries(candidates.map((m) => [m, scoresByMethod[m].filter((s) => s === 2).length])) as Record<RetrievalStrategy, number>;
      const maxTwo = Math.max(...candidates.map((m) => twoCounts[m]));
      candidates = candidates.filter((m) => twoCounts[m] === maxTwo);
    }
    for (let rank = 0; rank < 5 && candidates.length > 1; rank++) {
      const atRank = Object.fromEntries(candidates.map((m) => [m, scoresByMethod[m][rank] ?? 0])) as Record<RetrievalStrategy, number>;
      const maxAtRank = Math.max(...candidates.map((m) => atRank[m]));
      candidates = candidates.filter((m) => atRank[m] === maxAtRank);
    }
    if (candidates.length === 1) wins[candidates[0]]++;
    else ties++;
  }

  function printBucket(label: string, bucket: typeof totals) {
    console.log(`\n${label}`);
    for (const method of METHODS) {
      const t = bucket[method];
      if (t.queries === 0) continue;
      const avgP = t.precisionAt5Sum / t.queries;
      const avgR = t.returned > 0 ? t.avgRelevanceSum / t.queries : 0;
      const avgN = t.ndcgSum / t.queries;
      const totalGraded = t.dist[0] + t.dist[1] + t.dist[2];
      const twoRate = totalGraded > 0 ? (100 * t.dist[2]) / totalGraded : 0;
      console.log(
        `  ${method.padEnd(9)}: P@5=${avgP.toFixed(3)}  NDCG@5=${avgN.toFixed(3)}  AvgRel=${avgR.toFixed(3)}  ` +
          `score-2 rate=${twoRate.toFixed(1)}%  dist(0/1/2)=${t.dist[0]}/${t.dist[1]}/${t.dist[2]}  returned=${t.returned}`
      );
      if (totalGraded === 0) console.log(`    (no graded cells for ${method} in this bucket — metric uninformative, not zero-evidence)`);
    }
  }

  console.log("Step 17C retrieval evaluation — discriminating benchmark results");
  printBucket("OVERALL", totals);
  for (const cat of Object.keys(categoryTotals).sort()) {
    printBucket(`CATEGORY: ${cat}`, categoryTotals[cat]);
  }
  console.log(`\nWins: ${JSON.stringify(wins)}  Ties: ${ties}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--score")) {
    const judgmentsPath = args[args.indexOf("--score") + 1];
    if (!judgmentsPath) {
      console.error("Usage: npm run ai:retrieval-eval-17c -- --score path/to/judgments.json");
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
  console.error("ai:retrieval-eval-17c failed:", error);
  process.exitCode = 1;
});

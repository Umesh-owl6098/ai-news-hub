import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderUsage } from "@/lib/ai/types";
import type { BriefingSynthesisOutput } from "@/lib/ai/briefingSynthesisSchema";
import type { GroundingIssue } from "@/lib/ai/briefingSynthesisEvidence";

/**
 * Step 23 — EXPERIMENTAL, evaluation-only (see briefingSynthesisSchema.ts).
 * File-based cache, not a DB table: this experiment has no production
 * persistence need (Step 23 §7 — "do not add production briefing tables
 * merely for an experiment"), so a single JSON file per evidence hash
 * under the same gitignored artifacts convention as `evaluationHarness.ts`
 * (`artifacts/ai-evaluation/`) is the smallest correct mechanism. Keyed by
 * evidence hash (which already folds in the model and prompt version —
 * see `computeEvidenceHash`), so re-running against unchanged evidence
 * with the same model/prompt is always a cache hit: zero additional
 * OpenAI calls unless the caller passes `force`.
 */
export const BRIEFING_SYNTHESIS_CACHE_DIR = path.join(
  process.cwd(),
  "artifacts",
  "ai-evaluation",
  "briefing-synthesis-cache"
);

export interface CachedBriefingSynthesis {
  evidenceHash: string;
  model: string;
  promptVersion: string;
  generatedAt: string;
  output: BriefingSynthesisOutput;
  usage?: ProviderUsage;
  estimatedCostUsd: number | null;
  latencyMs: number;
  groundingIssues: GroundingIssue[];
}

function cachePathFor(dir: string, evidenceHash: string): string {
  return path.join(dir, `${evidenceHash}.json`);
}

/** Returns `null` on a cache miss OR any read/parse failure — a corrupt
 * or missing cache file must degrade to "re-run," never crash the CLI. */
export async function readCachedBriefingSynthesis(
  evidenceHash: string,
  dir: string = BRIEFING_SYNTHESIS_CACHE_DIR
): Promise<CachedBriefingSynthesis | null> {
  try {
    const raw = await readFile(cachePathFor(dir, evidenceHash), "utf8");
    return JSON.parse(raw) as CachedBriefingSynthesis;
  } catch {
    return null;
  }
}

export async function writeCachedBriefingSynthesis(
  entry: CachedBriefingSynthesis,
  dir: string = BRIEFING_SYNTHESIS_CACHE_DIR
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = cachePathFor(dir, entry.evidenceHash);
  await writeFile(filePath, JSON.stringify(entry, null, 2), "utf8");
  return filePath;
}

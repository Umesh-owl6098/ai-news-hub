import "server-only";
import { getRecentFeedItems, getRecentFeedItemsBySource } from "@/db/repository";
import type { FeedItem, SourceType } from "@/types/feed";

/**
 * Checked-in, deterministic selection plan for the AI-quality evaluation
 * set (see Step 10 §6-7). Bucketed by source family — a bounded few items
 * from EACH family — rather than "the newest N rows overall," which would
 * be dominated by whichever single source posts most often (in this app,
 * usually Hacker News). Given a fixed database snapshot, each bucket's
 * query (`ORDER BY published_at DESC, id DESC LIMIT n`) is fully
 * deterministic, so the selected set is reproducible run-to-run against
 * unchanged data — real sourceKeys are dynamic external ids (hn:123456,
 * an arXiv id, "owner/repo", an RSS guid) that don't exist until live
 * ingestion actually runs, so the reproducible unit here is the
 * *selection algorithm*, not a hardcoded list of specific ids.
 */
export interface EvaluationBucket {
  label: string;
  sourceType: SourceType;
  /** RSS publisher id (see data/rssSources.ts) — only meaningful for sourceType "news". */
  sourceId?: string;
  limit: number;
}

export const EVALUATION_BUCKETS: EvaluationBucket[] = [
  { label: "Hacker News", sourceType: "hackernews", limit: 3 },
  { label: "arXiv", sourceType: "paper", limit: 3 },
  { label: "GitHub", sourceType: "github", limit: 3 },
  { label: "OpenAI", sourceType: "news", sourceId: "openai", limit: 2 },
  { label: "Hugging Face", sourceType: "news", sourceId: "huggingface", limit: 2 },
  { label: "Google DeepMind", sourceType: "news", sourceId: "deepmind", limit: 2 },
  { label: "Google Research", sourceType: "news", sourceId: "google-research", limit: 2 },
];

export const EVALUATION_TARGET_MAX = 20;

export interface EvaluationItem {
  sourceKey: string;
  bucketLabel: string;
  item: FeedItem;
}

/**
 * Pulls the deterministic evaluation set from whatever is currently
 * persisted. Read-only — no live network fetch, no provider call. Returns
 * fewer than the bucket totals whenever a source has less real data than
 * its bucket limit (e.g. a freshly-seeded database); this is expected and
 * reported, not padded with placeholders.
 */
export async function selectEvaluationSet(): Promise<EvaluationItem[]> {
  const results: EvaluationItem[] = [];

  for (const bucket of EVALUATION_BUCKETS) {
    const items = bucket.sourceId
      ? await getRecentFeedItemsBySource(bucket.sourceType, bucket.sourceId, bucket.limit)
      : await getRecentFeedItems({ sourceType: bucket.sourceType, limit: bucket.limit });

    for (const item of items) {
      results.push({ sourceKey: item.id, bucketLabel: bucket.label, item });
    }
  }

  return results.slice(0, EVALUATION_TARGET_MAX);
}

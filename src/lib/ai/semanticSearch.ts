import "server-only";
import { searchFeedItems, vectorSearchFeedItems, DatabaseError } from "@/db/repository";
import { getEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import { EMBEDDING_SCHEMA_VERSION } from "@/lib/ai/semanticDocument";
import type { EmbeddingProvider } from "@/lib/ai/embeddingTypes";
import type { FeedItem, SourceType } from "@/types/feed";

/**
 * Retrieval plumbing built in Step 17 for evaluation. As of Step 18,
 * `semanticSearch` is also called directly from `src/lib/search.ts`'s
 * `performSearch` for user-facing Semantic-mode search. `lexicalSearch` and
 * `hybridSearch` remain evaluation/internal-only — Hybrid is deliberately
 * not exposed as a production search mode (see the Step 18 final report).
 */

export interface RetrievalFilters {
  sourceType?: SourceType;
  sourceId?: string;
  sinceDays?: number;
  bookmarkedOnly?: boolean;
}

export interface RetrievalResultItem {
  item: FeedItem;
  /** Strategy-specific. Comparable ACROSS items within the same call's
   * results; never comparable between a `lexicalSearch` score and a
   * `semanticSearch` score — that incomparability is exactly why
   * `hybridSearch` uses rank fusion instead of blending raw scores. */
  score: number;
}

export type RetrievalStrategy = "lexical" | "semantic" | "hybrid";

const MAX_RETRIEVAL_LIMIT = 50;

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RETRIEVAL_LIMIT) : 10;
}

/**
 * Thin wrapper over the existing, unmodified Step 8 `searchFeedItems` —
 * exists so lexical, semantic, and hybrid retrieval share one result
 * shape (`RetrievalResultItem[]`) for comparison. `score` here is a
 * positional pseudo-score (`1 / (rank + 1)`), not the real `ts_rank_cd`
 * value (which `searchFeedItems` computes internally but doesn't
 * currently return) — sufficient for Reciprocal Rank Fusion, which only
 * ever depends on rank position, and for reporting relative ordering, but
 * never meant to be read as an absolute relevance score.
 */
export async function lexicalSearch(query: string, filters: RetrievalFilters, limit: number): Promise<RetrievalResultItem[]> {
  const boundedLimit = clampLimit(limit);
  const result = await searchFeedItems({
    query,
    sourceType: filters.sourceType,
    sourceId: filters.sourceId,
    sinceDays: filters.sinceDays,
    bookmarkedOnly: filters.bookmarkedOnly,
    sort: "relevance",
    limit: boundedLimit,
    offset: 0,
  });
  return result.items.map((item, index) => ({ item, score: 1 / (index + 1) }));
}

/**
 * Embeds the query exactly once, then runs a filtered vector-similarity
 * search. Returns `[]` (never throws) when no embedding provider/model is
 * configured — the same safe no-op contract as enrichment's
 * `getAiProvider() === null`. `score` is `1 - cosineDistance` (higher is
 * more similar), for readability only.
 */
export async function semanticSearch(
  query: string,
  filters: RetrievalFilters,
  limit: number,
  options: { provider?: EmbeddingProvider } = {}
): Promise<RetrievalResultItem[]> {
  const provider = options.provider ?? getEmbeddingProvider();
  if (!provider) return [];

  const trimmed = query.trim();
  if (!trimmed) return [];

  const boundedLimit = clampLimit(limit);
  const { embeddings } = await provider.embed([trimmed]);
  const queryResult = embeddings[0];
  if (!queryResult) return [];

  try {
    const rows = await vectorSearchFeedItems({
      queryEmbedding: queryResult.embedding,
      provider: provider.name,
      model: provider.model,
      embeddingVersion: EMBEDDING_SCHEMA_VERSION,
      sourceType: filters.sourceType,
      sourceId: filters.sourceId,
      sinceDays: filters.sinceDays,
      bookmarkedOnly: filters.bookmarkedOnly,
      limit: boundedLimit,
    });
    return rows.map((row) => ({ item: row.item, score: 1 - row.distance }));
  } catch (error) {
    if (error instanceof DatabaseError) return [];
    throw error;
  }
}

/**
 * Standard Reciprocal Rank Fusion constant from Cormack, Clarke & Büttcher
 * (2009) — deliberately not tuned for this corpus; RRF's whole appeal is
 * that k=60 is a robust default that doesn't require per-application
 * calibration. Kept as a named, documented constant rather than an inline
 * magic number specifically so it's visible to whoever reviews the Step
 * 17 evaluation results.
 */
const RRF_K = 60;

/**
 * Deterministic hybrid retrieval: runs lexical and semantic search over a
 * wider pool than `limit`, then fuses by Reciprocal Rank Fusion — a
 * robust way to combine two ranked lists whose raw scores live on
 * incomparable scales (`ts_rank_cd` vs. cosine similarity), without
 * trying to normalize/blend those scores directly. No ML reranking, no
 * extra model call beyond the one query embedding `semanticSearch`
 * already makes. If the embedding provider isn't configured, this
 * degrades to pure lexical ranking (RRF over one non-empty list is just
 * that list's own order) rather than failing.
 */
export async function hybridSearch(
  query: string,
  filters: RetrievalFilters,
  limit: number,
  options: { provider?: EmbeddingProvider } = {}
): Promise<RetrievalResultItem[]> {
  const boundedLimit = clampLimit(limit);
  const poolSize = clampLimit(boundedLimit * 3);

  const [lexical, semantic] = await Promise.all([
    lexicalSearch(query, filters, poolSize),
    semanticSearch(query, filters, poolSize, options),
  ]);

  const fused = new Map<string, { item: FeedItem; score: number }>();
  const addRankedList = (results: RetrievalResultItem[]) => {
    results.forEach((result, rank) => {
      const key = result.item.id;
      const rrfContribution = 1 / (RRF_K + rank + 1);
      const existing = fused.get(key);
      fused.set(key, { item: existing?.item ?? result.item, score: (existing?.score ?? 0) + rrfContribution });
    });
  };
  addRankedList(lexical);
  addRankedList(semantic);

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, boundedLimit);
}

export async function runRetrieval(
  strategy: RetrievalStrategy,
  query: string,
  filters: RetrievalFilters,
  limit: number,
  options: { provider?: EmbeddingProvider } = {}
): Promise<RetrievalResultItem[]> {
  if (strategy === "lexical") return lexicalSearch(query, filters, limit);
  if (strategy === "semantic") return semanticSearch(query, filters, limit, options);
  return hybridSearch(query, filters, limit, options);
}

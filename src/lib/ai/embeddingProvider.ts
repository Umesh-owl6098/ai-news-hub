import "server-only";
import type { EmbeddingProvider } from "@/lib/ai/embeddingTypes";
import { createOpenAiEmbeddingProvider } from "@/lib/ai/openaiEmbeddingProvider";
import { isAiEgressDisabled } from "@/lib/ai/egress";

/**
 * The one place application code asks "which embedding provider/model, if
 * any, is configured?" — mirrors `provider.ts`'s `getAiProvider()`.
 * Reads `process.env` only inside the function body, never at module
 * scope (must succeed with nothing configured during `next build`'s
 * static analysis).
 *
 * Step 17 standing requirement: this app must NEVER silently choose an
 * embedding model. `OPENAI_EMBEDDING_MODEL` has no default and no
 * fallback to any other env var (specifically not inferred from
 * `OPENAI_ENRICHMENT_MODEL`) — until a human sets it explicitly, this
 * returns `null` and every caller (the embedding CLI, the embedding
 * service, semantic search) treats that exactly like "embeddings are
 * disabled," the same safe no-op contract `getAiProvider() === null`
 * already has for enrichment.
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  // Step 27B: takes precedence over any credentials below — see egress.ts.
  if (isAiEgressDisabled()) return null;

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_EMBEDDING_MODEL;
  if (!apiKey || !model) return null;
  return createOpenAiEmbeddingProvider(apiKey, model);
}

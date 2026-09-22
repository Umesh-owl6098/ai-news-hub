import type { EmbeddingBatchResult, EmbeddingProvider } from "@/lib/ai/embeddingTypes";

/** Small on purpose — tests only need deterministic, distinguishable
 * vectors, never a realistic embedding dimensionality. */
const MOCK_DIMENSIONS = 8;

/**
 * Deterministic, zero-cost, zero-network embedding provider for automated
 * tests — same text always produces the same vector, different text
 * produces a different vector, with no randomness and no network call.
 * Never used when a real provider is configured; see embeddingProvider.ts.
 */
export function createMockEmbeddingProvider(model = "mock-embedding-v1"): EmbeddingProvider {
  return {
    name: "mock",
    model,
    async embed(texts: string[]): Promise<EmbeddingBatchResult> {
      const embeddings = texts.map((text) => ({
        embedding: hashToVector(text),
        dimensions: MOCK_DIMENSIONS,
      }));
      return { embeddings, usage: { inputTokens: texts.reduce((sum, t) => sum + t.length, 0) } };
    },
  };
}

/** A simple deterministic hash-based pseudo-embedding: every position is a
 * different rolling hash of the text, normalized into [-1, 1]. Not a real
 * embedding in any semantic sense — good enough to make mock-provider
 * tests exercise real vector-similarity math (cosine distance genuinely
 * differs for genuinely different text) without ever calling a real API. */
function hashToVector(text: string): number[] {
  const vector: number[] = [];
  for (let dim = 0; dim < MOCK_DIMENSIONS; dim++) {
    let acc = dim * 2654435761;
    for (let i = 0; i < text.length; i++) {
      acc = (acc * 31 + text.charCodeAt(i) + dim) >>> 0;
    }
    vector.push((acc % 2000) / 1000 - 1); // normalize to [-1, 1)
  }
  return vector;
}

import type { AiProvider, ArticleEnrichmentInput, ProviderCallResult } from "@/lib/ai/types";
import { AI_TOPICS } from "@/lib/ai/taxonomy";

/**
 * Deterministic, zero-cost, zero-network provider for automated tests and
 * local development without an API key. Same input always produces the
 * same output — no randomness — so tests asserting caching/call-count
 * behavior stay stable. Never used when a real provider is configured;
 * see provider.ts.
 */
export function createMockProvider(): AiProvider {
  return {
    name: "mock",
    model: "mock-deterministic-v1",
    async enrichArticle(input: ArticleEnrichmentInput): Promise<ProviderCallResult> {
      const text = `${input.title} ${input.summary}`.toLowerCase();
      const topic = AI_TOPICS.find((t) => text.includes(t.toLowerCase())) ?? "Other";

      // Deterministic pseudo-score from a simple hash of the title, kept
      // in [0, 1] — good enough to exercise ranking/sorting in tests
      // without ever calling a real model.
      let acc = 0;
      for (let i = 0; i < input.title.length; i++) acc = (acc * 31 + input.title.charCodeAt(i)) % 1000;
      const relevanceScore = Math.round((acc / 1000) * 100) / 100;

      // No `usage` — the mock never talks to a real API, so fabricating
      // token counts would misrepresent real cost in any report that
      // reads this field. Evaluation reports must treat mock runs as
      // harness-correctness checks, never as real quality/cost evidence.
      return {
        output: {
          summary: `Mock summary of "${input.title.slice(0, 80)}" from ${input.sourceName}.`,
          topics: [topic],
          relevanceScore,
        },
      };
    },
  };
}

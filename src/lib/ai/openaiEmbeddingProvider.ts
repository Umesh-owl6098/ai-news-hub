import "server-only";
import { z } from "zod";
import type { EmbeddingBatchResult, EmbeddingProvider } from "@/lib/ai/embeddingTypes";
import { EmbeddingProviderError } from "@/lib/ai/embeddingTypes";
import { isAiEgressDisabled, AI_EGRESS_DISABLED_MESSAGE_PREFIX } from "@/lib/ai/egress";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const REQUEST_TIMEOUT_MS = 15_000;

/** Hard safety cap on a single provider call, independent of whatever
 * batch size the CLI/service layer chooses to request — never silently
 * truncated, a too-large batch is a caller bug and should throw loudly. */
const MAX_EMBEDDING_BATCH_SIZE = 100;

const responseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number(),
    })
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
    })
    .optional(),
});

/**
 * Thin, dependency-free adapter over OpenAI's Embeddings API using plain
 * `fetch` — mirrors the structure of `openaiProvider.ts` (the enrichment
 * adapter): explicit timeout, narrow error-code mapping, no raw
 * response body ever surfaced in an error message.
 */
export function createOpenAiEmbeddingProvider(apiKey: string, model: string): EmbeddingProvider {
  return {
    name: "openai",
    model,
    async embed(texts: string[]): Promise<EmbeddingBatchResult> {
      // Step 27B: defense-in-depth — see openaiProvider.ts's identical check.
      // Checked even before the empty-batch no-op below, so a disabled-
      // egress caller never gets a misleadingly "successful" empty result.
      if (isAiEgressDisabled()) {
        throw new EmbeddingProviderError("not_configured", `${AI_EGRESS_DISABLED_MESSAGE_PREFIX} OpenAI embeddings.`);
      }
      if (texts.length === 0) return { embeddings: [] };
      if (texts.length > MAX_EMBEDDING_BATCH_SIZE) {
        throw new EmbeddingProviderError(
          "provider_error",
          `Batch of ${texts.length} texts exceeds the ${MAX_EMBEDDING_BATCH_SIZE}-text provider limit.`
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(OPENAI_EMBEDDINGS_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new EmbeddingProviderError("timeout", "OpenAI embeddings request timed out.");
        }
        throw new EmbeddingProviderError("provider_error", "OpenAI embeddings request failed before a response was received.");
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 429) {
        throw new EmbeddingProviderError("rate_limited", "OpenAI rate limit reached.");
      }
      if (!response.ok) {
        // Never surface response.body — it may echo request details back.
        throw new EmbeddingProviderError("provider_error", `OpenAI embeddings API returned HTTP ${response.status}.`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new EmbeddingProviderError("invalid_output", "OpenAI embeddings response was not valid JSON.");
      }

      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        throw new EmbeddingProviderError("invalid_output", `OpenAI embeddings response failed schema validation: ${parsed.error.message}`);
      }
      if (parsed.data.data.length !== texts.length) {
        throw new EmbeddingProviderError(
          "invalid_output",
          `OpenAI embeddings response returned ${parsed.data.data.length} vectors for ${texts.length} inputs.`
        );
      }

      // The API is documented to preserve input order, but `index` is
      // returned specifically so a caller never has to assume that —
      // sort by it explicitly rather than trusting array order.
      const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
      const embeddings = ordered.map((item) => ({ embedding: item.embedding, dimensions: item.embedding.length }));

      const usage = parsed.data.usage?.prompt_tokens !== undefined ? { inputTokens: parsed.data.usage.prompt_tokens } : undefined;

      return { embeddings, usage };
    },
  };
}

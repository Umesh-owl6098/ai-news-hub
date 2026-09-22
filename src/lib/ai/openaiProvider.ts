import "server-only";
import { z } from "zod";
import type { AiProvider, ArticleEnrichmentInput, ProviderCallResult } from "@/lib/ai/types";
import { ProviderError } from "@/lib/ai/types";
import { buildEnrichmentPrompt } from "@/lib/ai/prompt";
import { enrichmentOutputSchema } from "@/lib/ai/schema";
import { AI_TOPICS } from "@/lib/ai/taxonomy";
import { isAiEgressDisabled, AI_EGRESS_DISABLED_MESSAGE_PREFIX } from "@/lib/ai/egress";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_TOKENS = 500;

/**
 * JSON Schema for OpenAI's Structured Outputs (`strict: true`) — the API
 * enforces this shape server-side, so a well-formed response is
 * guaranteed to parse. `enrichmentOutputSchema` (Zod) still re-validates
 * it afterward regardless, exactly like the Anthropic adapter: an
 * upstream guarantee is not a substitute for our own boundary check, and
 * strict-mode schemas can't express every constraint we care about
 * (topic count bounds, score range) — Zod is the single source of truth
 * for those.
 */
const OPENAI_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    topics: { type: "array", items: { type: "string", enum: [...AI_TOPICS] } },
    relevanceScore: { type: "number" },
  },
  required: ["summary", "topics", "relevanceScore"],
  additionalProperties: false,
} as const;

const responseSchema = z.object({
  status: z.string().optional(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      })
    )
    .optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

/**
 * Thin, dependency-free adapter over OpenAI's Responses API (the API
 * OpenAI's own docs currently recommend for new text-generation
 * integrations, over the older Chat Completions API — verified against
 * their official docs before implementing this) using plain `fetch`.
 * Structured output is enforced via `text.format: { type: "json_schema",
 * strict: true, ... }` rather than prompting for JSON and hoping.
 */
export function createOpenAiProvider(apiKey: string, model: string): AiProvider {
  return {
    name: "openai",
    model,
    async enrichArticle(input: ArticleEnrichmentInput): Promise<ProviderCallResult> {
      // Step 27B: refuses BEFORE building a prompt or opening a connection —
      // the defense-in-depth layer that also covers callers constructing
      // this provider directly (bypassing getAiProvider()), e.g. the
      // scripts/ai-compare-models.ts and ai-augment-experiment.ts CLIs.
      if (isAiEgressDisabled()) {
        throw new ProviderError("not_configured", `${AI_EGRESS_DISABLED_MESSAGE_PREFIX} OpenAI.`);
      }

      const { system, user } = buildEnrichmentPrompt(input);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(OPENAI_API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            text: {
              format: {
                type: "json_schema",
                name: "article_enrichment",
                strict: true,
                schema: OPENAI_JSON_SCHEMA,
              },
            },
            max_output_tokens: MAX_OUTPUT_TOKENS,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new ProviderError("timeout", "OpenAI request timed out.");
        }
        throw new ProviderError("provider_error", "OpenAI request failed before a response was received.");
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 429) {
        throw new ProviderError("rate_limited", "OpenAI rate limit reached.");
      }
      if (!response.ok) {
        // Never surface response.body — it may echo request details back.
        throw new ProviderError("provider_error", `OpenAI API returned HTTP ${response.status}.`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProviderError("invalid_output", "OpenAI response was not valid JSON.");
      }

      const parsed = responseSchema.safeParse(body);
      const messageItem = parsed.success ? parsed.data.output?.find((item) => item.type === "message") : undefined;
      const text = messageItem?.content?.find((block) => block.type === "output_text")?.text;
      if (!text) {
        throw new ProviderError("invalid_output", "OpenAI response had no output_text content block.");
      }

      let payload: unknown;
      try {
        payload = extractJsonPayload(text);
      } catch {
        throw new ProviderError("invalid_output", "Model output was not valid JSON.");
      }

      const result = enrichmentOutputSchema.safeParse(payload);
      if (!result.success) {
        throw new ProviderError("invalid_output", `Model output failed schema validation: ${result.error.message}`);
      }

      const rawUsage = parsed.success ? parsed.data.usage : undefined;
      const usage =
        rawUsage && (rawUsage.input_tokens !== undefined || rawUsage.output_tokens !== undefined)
          ? { inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens }
          : undefined;

      return { output: result.data, usage };
    },
  };
}

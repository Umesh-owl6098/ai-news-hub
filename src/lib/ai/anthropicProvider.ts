import "server-only";
import { z } from "zod";
import type { AiProvider, ArticleEnrichmentInput, ProviderCallResult } from "@/lib/ai/types";
import { ProviderError } from "@/lib/ai/types";
import { buildEnrichmentPrompt } from "@/lib/ai/prompt";
import { enrichmentOutputSchema } from "@/lib/ai/schema";
import { isAiEgressDisabled, AI_EGRESS_DISABLED_MESSAGE_PREFIX } from "@/lib/ai/egress";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
// Verified current against Anthropic's own docs (platform.claude.com) on
// 2026-09-09 — "Haiku 4.5" resolves to exactly this snapshot id; unchanged
// from Step 9's default, so no model migration was needed this milestone.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_TOKENS = 500;

const messageResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  // Present on every real Messages API response; optional here only so a
  // malformed/truncated body doesn't fail *parsing* before we've had a
  // chance to classify it — usage is read defensively below either way.
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

/**
 * Extracts a JSON object from model output that is expected to be pure
 * JSON but, defensively, might arrive wrapped in a markdown code fence —
 * models do this even when told not to. Never uses a regex to pull fields
 * out of prose; this only strips an optional fence before handing the
 * whole thing to JSON.parse + schema validation.
 */
function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1] : trimmed;
  return JSON.parse(jsonText);
}

/**
 * Thin, dependency-free adapter over Anthropic's Messages API using plain
 * `fetch` — no SDK needed for one JSON-in/JSON-out call, which keeps this
 * file the *only* place that knows an HTTP call happens at all. Everything
 * above this (enrichment service, repository, UI) only ever sees the
 * provider-neutral `AiProvider` interface.
 */
export function createAnthropicProvider(apiKey: string, model: string = DEFAULT_MODEL): AiProvider {
  return {
    name: "anthropic",
    model,
    async enrichArticle(input: ArticleEnrichmentInput): Promise<ProviderCallResult> {
      // Step 27B: defense-in-depth — see openaiProvider.ts's identical check.
      if (isAiEgressDisabled()) {
        throw new ProviderError("not_configured", `${AI_EGRESS_DISABLED_MESSAGE_PREFIX} Anthropic.`);
      }

      const { system, user } = buildEnrichmentPrompt(input);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(ANTHROPIC_API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_API_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            messages: [{ role: "user", content: user }],
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new ProviderError("timeout", "Anthropic request timed out.");
        }
        // Network failure, DNS, TLS, etc. — safe to log the error name only.
        throw new ProviderError("provider_error", "Anthropic request failed before a response was received.");
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 429) {
        throw new ProviderError("rate_limited", "Anthropic rate limit reached.");
      }
      if (!response.ok) {
        // Never surface response.body — it may echo request details back.
        throw new ProviderError("provider_error", `Anthropic API returned HTTP ${response.status}.`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProviderError("invalid_output", "Anthropic response was not valid JSON.");
      }

      const parsedMessage = messageResponseSchema.safeParse(body);
      const text = parsedMessage.success
        ? parsedMessage.data.content.find((block) => block.type === "text")?.text
        : undefined;
      if (!text) {
        throw new ProviderError("invalid_output", "Anthropic response had no text content block.");
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

      const rawUsage = parsedMessage.success ? parsedMessage.data.usage : undefined;
      const usage =
        rawUsage && (rawUsage.input_tokens !== undefined || rawUsage.output_tokens !== undefined)
          ? { inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens }
          : undefined;

      return { output: result.data, usage };
    },
  };
}

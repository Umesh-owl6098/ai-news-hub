import { z } from "zod";
import { ProviderError, type ProviderErrorCode, type ProviderUsage } from "@/lib/ai/types";
import { buildBriefingSynthesisPrompt } from "@/lib/ai/briefingSynthesisPrompt";
import { briefingSynthesisOutputSchema, toOpenAiStrictJsonSchema, type BriefingSynthesisOutput } from "@/lib/ai/briefingSynthesisSchema";
import type { BriefingEvidenceItem } from "@/lib/ai/briefingSynthesisEvidence";
import { isAiEgressDisabled, AI_EGRESS_DISABLED_MESSAGE_PREFIX } from "@/lib/ai/egress";

/**
 * Step 23 — EXPERIMENTAL, evaluation-only (see briefingSynthesisSchema.ts
 * for the "not wired into production" note). Deliberately a SEPARATE,
 * parallel interface from `AiProvider` (types.ts) rather than adding a
 * second method to it: `AiProvider` is the production article-enrichment
 * seam, and this experiment must stay trivially removable without
 * touching that interface's shape or its other implementations. It does
 * reuse `ProviderError`/`ProviderUsage`/`ProviderErrorCode` from types.ts
 * directly — those are already generic, not enrichment-specific.
 */
export interface BriefingSynthesisProvider {
  readonly name: string;
  readonly model: string;
  synthesize(evidence: BriefingEvidenceItem[]): Promise<{ output: BriefingSynthesisOutput; usage?: ProviderUsage }>;
}

/**
 * Step 23C §7 — the stage a failed call died at, for honest diagnostics
 * without ever needing to log raw model output. Ordered roughly by how
 * far the call got: a later stage means more of the round trip
 * succeeded (e.g. `schema_validation` means we DID get a complete,
 * parseable JSON response — Call 2's actual failure stage).
 */
export type BriefingSynthesisFailureStage =
  | "network"
  | "http_status"
  | "envelope_parse"
  | "incomplete"
  | "no_output_text"
  | "invalid_json"
  | "schema_validation";

/**
 * Step 23C §7 — thrown instead of a bare `ProviderError` so a failed
 * call still carries whatever safe diagnostic metadata was actually
 * available at the point of failure (completion status, usage, latency,
 * which stage it died at). The second real call (Call 2) revealed this
 * gap: usage and latency were both lost once `synthesize()` threw,
 * because they were only computed on the success path. Never carries
 * raw model output text — only structured, already-safe fields (numbers,
 * short enum-like strings) that were already being logged/reported
 * elsewhere. Extends `ProviderError` (not a competing type) so any
 * existing `instanceof ProviderError` / `.code` handling keeps working
 * unchanged; callers that want the extra diagnostics check
 * `instanceof BriefingSynthesisCallError` specifically.
 */
export class BriefingSynthesisCallError extends ProviderError {
  readonly stage: BriefingSynthesisFailureStage;
  readonly latencyMs: number;
  readonly usage?: ProviderUsage;
  readonly completionStatus?: string;

  constructor(params: {
    code: ProviderErrorCode;
    message: string;
    stage: BriefingSynthesisFailureStage;
    latencyMs: number;
    usage?: ProviderUsage;
    completionStatus?: string;
  }) {
    super(params.code, params.message);
    this.name = "BriefingSynthesisCallError";
    this.stage = params.stage;
    this.latencyMs = params.latencyMs;
    this.usage = params.usage;
    this.completionStatus = params.completionStatus;
  }
}

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const REQUEST_TIMEOUT_MS = 30_000;
// Generous headroom for a FULL strict-JSON response (up to 8 highlights x
// summary+whyItMatters, plus up to 4 connections) — Call 1 was truncated
// mid-JSON at 1500 (status: "incomplete", reason: "max_output_tokens").
const MAX_OUTPUT_TOKENS = 4000;

const responseEnvelopeSchema = z.object({
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
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
 * Thin adapter over OpenAI's Responses API — mirrors `openaiProvider.ts`'s
 * calling convention (same endpoint, same Structured Outputs mode, same
 * timeout/abort handling, same `ProviderError` classification, same
 * usage-extraction shape) targeting a different schema/prompt. Kept as a
 * separate function rather than a shared helper because the two schemas
 * (enrichment vs. this) are genuinely different contracts with different
 * callers — but every convention below is intentionally identical, not
 * independently invented, so a reviewer already familiar with
 * openaiProvider.ts can read this in seconds.
 *
 * The ENTIRE body runs inside a try/finally that always computes
 * `latencyMs` from a single `startedAt` captured before the fetch — Call
 * 2 revealed that computing latency only on the success path silently
 * loses it whenever the call fails after a response was received but
 * before a full BriefingSynthesisOutput could be assembled.
 */
export function createOpenAiBriefingSynthesisProvider(apiKey: string, model: string): BriefingSynthesisProvider {
  return {
    name: "openai",
    model,
    async synthesize(evidence: BriefingEvidenceItem[]) {
      const startedAt = Date.now();
      const fail = (code: ProviderErrorCode, message: string, stage: BriefingSynthesisFailureStage, extra?: { usage?: ProviderUsage; completionStatus?: string }) => {
        throw new BriefingSynthesisCallError({
          code,
          message,
          stage,
          latencyMs: Date.now() - startedAt,
          usage: extra?.usage,
          completionStatus: extra?.completionStatus,
        });
      };

      // Step 27B: defense-in-depth — see openaiProvider.ts's identical
      // check. Checked before building a prompt or opening a connection;
      // this is what actually stops scripts/ai-briefing-evaluate.ts, which
      // constructs this provider directly rather than via a shared factory.
      if (isAiEgressDisabled()) {
        return fail("not_configured", `${AI_EGRESS_DISABLED_MESSAGE_PREFIX} OpenAI.`, "network");
      }

      const { system, user } = buildBriefingSynthesisPrompt(evidence);

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
                name: "briefing_synthesis",
                strict: true,
                schema: toOpenAiStrictJsonSchema(),
              },
            },
            max_output_tokens: MAX_OUTPUT_TOKENS,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return fail("timeout", "OpenAI request timed out.", "network");
        }
        return fail("provider_error", "OpenAI request failed before a response was received.", "network");
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 429) {
        return fail("rate_limited", "OpenAI rate limit reached.", "http_status");
      }
      if (!response.ok) {
        // Never surface response.body — it may echo request details back.
        return fail("provider_error", `OpenAI API returned HTTP ${response.status}.`, "http_status");
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return fail("invalid_output", "OpenAI response was not valid JSON.", "envelope_parse");
      }

      const parsed = responseEnvelopeSchema.safeParse(body);

      // Extracted BEFORE any downstream step that might throw, so a
      // truncated/malformed/oversized response still reports real spend —
      // a failed call still consumed real tokens (this is the exact
      // observability gap Call 2 exposed: usage was previously extracted
      // only after schema validation succeeded).
      const rawUsage = parsed.success ? parsed.data.usage : undefined;
      const usage: ProviderUsage | undefined =
        rawUsage && (rawUsage.input_tokens !== undefined || rawUsage.output_tokens !== undefined)
          ? { inputTokens: rawUsage.input_tokens, outputTokens: rawUsage.output_tokens }
          : undefined;
      const completionStatus = parsed.success ? parsed.data.status : undefined;

      if (completionStatus === "incomplete") {
        const reason = parsed.success ? (parsed.data.incomplete_details?.reason ?? "unknown") : "unknown";
        return fail(
          "invalid_output",
          `OpenAI response was truncated before completion (reason: ${reason}) — max_output_tokens may be too low for this evidence size.`,
          "incomplete",
          { usage, completionStatus }
        );
      }

      const messageItem = parsed.success ? parsed.data.output?.find((item) => item.type === "message") : undefined;
      const text = messageItem?.content?.find((block) => block.type === "output_text")?.text;
      if (!text) {
        return fail("invalid_output", "OpenAI response had no output_text content block.", "no_output_text", { usage, completionStatus });
      }

      let payload: unknown;
      try {
        payload = extractJsonPayload(text);
      } catch {
        return fail("invalid_output", "Model output was not valid JSON.", "invalid_json", { usage, completionStatus });
      }

      const result = briefingSynthesisOutputSchema.safeParse(payload);
      if (!result.success) {
        return fail(
          "invalid_output",
          `Model output failed schema validation: ${result.error.message}`,
          "schema_validation",
          { usage, completionStatus }
        );
      }

      return { output: result.data, usage };
    },
  };
}

/**
 * Deterministic, zero-cost, zero-network provider for automated tests —
 * mirrors `mockProvider.ts`'s role for article enrichment. Every
 * highlight references a real evidence itemId (so grounding checks pass
 * against realistic fixtures) and includes no `usage` (a mock never
 * talks to a real API, so fabricating token counts would misrepresent
 * real cost in any report that reads this field). Always includes
 * `whyItMatters`/`connections` as explicit `null` (never omitted) to
 * satisfy the same required-but-nullable contract the real adapter's
 * derived JSON Schema enforces — see briefingSynthesisSchema.ts.
 */
export function createMockBriefingSynthesisProvider(): BriefingSynthesisProvider {
  return {
    name: "mock",
    model: "mock-deterministic-v1",
    async synthesize(evidence: BriefingEvidenceItem[]) {
      const highlights = evidence.slice(0, 3).map((item) => ({
        itemId: item.itemId,
        summary: `Mock summary of "${item.title.slice(0, 60)}".`,
        whyItMatters: null,
      }));
      return {
        output: {
          headline: "Mock briefing synthesis",
          overview: `Mock overview covering ${evidence.length} evidence item(s).`,
          highlights: highlights.length > 0 ? highlights : [{ itemId: "mock:none", summary: "No evidence supplied.", whyItMatters: null }],
          connections: null,
        },
      };
    },
  };
}

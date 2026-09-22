import { z } from "zod";

/**
 * Step 23 — EXPERIMENTAL, evaluation-only. Not wired into production
 * `/briefing` (see `src/lib/ai/briefingSynthesisEvidence.ts` for the
 * evidence-boundary rules and `scripts/ai-briefing-evaluate.ts` for the
 * only entry point that calls a real model). Mirrors the bounded,
 * strict-Zod convention established in `src/lib/ai/schema.ts` for
 * article enrichment — a model response is untrusted until it passes
 * this, regardless of what the provider's own structured-output mode
 * already enforced upstream.
 *
 * Step 23C — this is now the ONE authoritative definition of the
 * contract. The JSON Schema actually sent to OpenAI (see
 * `toOpenAiStrictJsonSchema` below, used by briefingSynthesisProvider.ts)
 * is MECHANICALLY DERIVED from these same Zod schemas via Zod 4's native
 * `z.toJSONSchema()` — there is no second, separately-hand-maintained
 * copy of these constraints to drift out of sync. That drift is exactly
 * what caused the second real-call failure (Call 2): the hand-written
 * provider schema never set `maxItems` on `highlights`/`connections`,
 * so nothing sent to OpenAI matched the Zod bound that rejected the
 * response afterward.
 *
 * `.nullable()` vs `.optional()`/`.nullish()` matters here in a way it
 * doesn't for ordinary Zod usage: OpenAI's strict Structured Outputs mode
 * requires EVERY declared property to appear in JSON Schema's `required`
 * array — there is no true "optional key," only a key whose TYPE
 * includes `null`. `.optional()`/`.nullish()` tell Zod's JSON Schema
 * generator "this key may be omitted," which drops it from `required` —
 * exactly the shape that caused Call 1's schema to be internally
 * inconsistent (a field marked `required` in the hand-written schema
 * with a type that didn't allow `null`). `.nullable()` instead tells Zod
 * "the key is always present; its value may be `null`," which is BOTH
 * what OpenAI strict mode needs AND what `z.toJSONSchema()` naturally
 * emits as `required` + a nullable `anyOf`. Every producer of this
 * shape — the real OpenAI adapter, the mock provider, and every test
 * fixture — must therefore always include `whyItMatters`/`connections`
 * as a key, using `null` rather than omitting it, to satisfy this schema.
 */

const MAX_HEADLINE_CHARS = 120;
const MAX_OVERVIEW_CHARS = 500;
const MAX_HIGHLIGHT_SUMMARY_CHARS = 300;
const MAX_WHY_IT_MATTERS_CHARS = 200;
const MAX_OBSERVATION_CHARS = 300;
export const MAX_HIGHLIGHTS = 8;
export const MAX_CONNECTIONS = 4;
export const MIN_CONNECTION_ITEM_IDS = 2;
const MAX_ITEM_ID_CHARS = 256;

const itemIdSchema = z.string().trim().min(1).max(MAX_ITEM_ID_CHARS);

export const briefingHighlightSchema = z
  .object({
    itemId: itemIdSchema,
    summary: z.string().trim().min(1).max(MAX_HIGHLIGHT_SUMMARY_CHARS),
    /** Always present; `null` when the evidence doesn't support a
     * meaningful implication — see the prompt's grounding rules and the
     * module comment above for why `null` (not omission) is required. */
    whyItMatters: z.string().trim().min(1).max(MAX_WHY_IT_MATTERS_CHARS).nullable(),
  })
  .strict();

export const briefingConnectionSchema = z
  .object({
    itemIds: z.array(itemIdSchema).min(MIN_CONNECTION_ITEM_IDS, "a connection must reference at least 2 items"),
    observation: z.string().trim().min(1).max(MAX_OBSERVATION_CHARS),
  })
  .strict();

export const briefingSynthesisOutputSchema = z
  .object({
    headline: z.string().trim().min(1).max(MAX_HEADLINE_CHARS),
    overview: z.string().trim().min(1).max(MAX_OVERVIEW_CHARS),
    highlights: z.array(briefingHighlightSchema).min(1).max(MAX_HIGHLIGHTS),
    /** Always present; `null` when there's nothing worth connecting —
     * see the module comment above. */
    connections: z.array(briefingConnectionSchema).max(MAX_CONNECTIONS).nullable(),
  })
  .strict();

export type BriefingHighlight = z.infer<typeof briefingHighlightSchema>;
export type BriefingConnection = z.infer<typeof briefingConnectionSchema>;
export type BriefingSynthesisOutput = z.infer<typeof briefingSynthesisOutputSchema>;

/**
 * Derives the JSON Schema actually sent to OpenAI's Structured Outputs
 * (`text.format.schema`) directly from `briefingSynthesisOutputSchema` —
 * the single authoritative contract. `$schema` is stripped: OpenAI's API
 * expects a bare JSON Schema object for this field, not one carrying a
 * meta-schema URI (every real example in OpenAI's own docs omits it).
 *
 * What this derivation gives us "for free," correctly, at every nested
 * level: `required` (every declared key, per the `.nullable()`-not-
 * `.optional()` convention above), `additionalProperties: false`,
 * `minLength`/`maxLength` on every string, `minItems`/`maxItems` on
 * every array. What it CANNOT express — because JSON Schema has no
 * concept of "unique by one field across sibling objects" — is the
 * "no duplicate highlight itemId" rule; that remains a downstream,
 * semantic check in `validateBriefingSynthesisGrounding`
 * (briefingSynthesisEvidence.ts), same as "every itemId must exist in
 * the supplied evidence" (JSON Schema has no way to reference an
 * external, per-request list of valid values either).
 */
export function toOpenAiStrictJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(briefingSynthesisOutputSchema) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

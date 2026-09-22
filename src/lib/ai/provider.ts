import "server-only";
import type { AiProvider } from "@/lib/ai/types";
import { createAnthropicProvider } from "@/lib/ai/anthropicProvider";
import { createOpenAiProvider } from "@/lib/ai/openaiProvider";
import { isAiEgressDisabled } from "@/lib/ai/egress";

/**
 * The one place application code asks "which provider, if any, is
 * configured?" Deliberately reads `process.env` only inside this function
 * body (never at module scope) — evaluating it at import time would run
 * during `next build`'s static analysis, which must succeed with no AI
 * provider configured at all.
 *
 * `AI_PROVIDER` is an explicit selector ("openai" | "anthropic"). Leaving
 * it unset preserves the original Step 9 behavior — a bare
 * `ANTHROPIC_API_KEY` still works with no other configuration — so
 * existing setups aren't broken by this addition.
 *
 * Unlike the Anthropic branch, OpenAI has no built-in default model: it
 * must come from `OPENAI_ENRICHMENT_MODEL`, chosen only after querying
 * which models the configured key can actually access. Guessing a model
 * name here would violate that — a missing model means "not configured,"
 * not "pick something."
 *
 * Every branch requires its OWN complete configuration. A
 * partially-configured provider (e.g. `AI_PROVIDER=openai` with no
 * `OPENAI_API_KEY`) returns null rather than guessing or falling through
 * to a different provider — silent fallback between providers would make
 * it unclear which one actually ran.
 *
 * Returns null — never throws — when nothing is configured. Every caller
 * (enrichment service, CLI script) treats a null provider as "AI
 * enrichment is disabled," not as an error.
 *
 * Step 27B: also returns null, unconditionally, when AI egress is
 * disabled (`AI_EGRESS_DISABLED=1`) — this takes precedence over any
 * credentials present, is checked before anything else below, and
 * reuses the exact same "not configured" contract every caller already
 * handles (see egress.ts).
 */
export function getAiProvider(): AiProvider | null {
  if (isAiEgressDisabled()) return null;

  const selector = process.env.AI_PROVIDER;

  if (selector === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_ENRICHMENT_MODEL;
    if (!apiKey || !model) return null;
    return createOpenAiProvider(apiKey, model);
  }

  if (selector === undefined || selector === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    const model = process.env.ANTHROPIC_ENRICHMENT_MODEL;
    return model ? createAnthropicProvider(apiKey, model) : createAnthropicProvider(apiKey);
  }

  return null;
}

import "server-only";

/**
 * Step 27B — one central switch for refusing every outbound AI-provider
 * request (OpenAI enrichment/embeddings, Anthropic enrichment, the
 * briefing-synthesis experiment) regardless of whether valid credentials
 * are present in the environment.
 *
 * This is a development/operational safety control, not credential
 * management: it exists so a developer can start the app (or run a CLI
 * script) in a mode where accidental navigation — e.g. to a Semantic-
 * search URL — or an accidental script invocation cannot make a real,
 * possibly billed request, even with real API keys loaded from
 * `.env.local`. It never inspects, logs, or reports credential values —
 * only whether this one boolean flag is set.
 *
 * Enforced in two layers (see the Step 27B final report for the audited
 * call-path proof of why one factory isn't enough):
 *   1. `getAiProvider()` / `getEmbeddingProvider()` return `null` when
 *      this is set, exactly like "nothing configured" — every existing
 *      caller (enrichment service, `performSearch`'s Semantic fallback,
 *      the `semanticAvailable` UI check) already has a correct, tested
 *      no-op/fallback path for that, so this needs no new UI or error
 *      handling anywhere.
 *   2. Each real provider adapter's own network-performing method
 *      (`openaiProvider.ts`, `anthropicProvider.ts`,
 *      `openaiEmbeddingProvider.ts`, `briefingSynthesisProvider.ts`)
 *      also refuses at its own first line, before building a prompt or
 *      opening a connection — this is what actually stops the two CLI
 *      scripts (`ai-augment-experiment.ts`, `ai-compare-models.ts`) and
 *      the briefing-synthesis CLI, which construct a provider directly
 *      rather than going through the shared factory functions.
 *
 * Read only inside function bodies, never at module scope — same
 * reasoning as `provider.ts`/`embeddingProvider.ts`: must not break
 * `next build`'s static analysis, which runs with no environment
 * configured at all.
 */
export function isAiEgressDisabled(): boolean {
  return process.env.AI_EGRESS_DISABLED === "1";
}

export const AI_EGRESS_DISABLED_MESSAGE_PREFIX = "AI egress is disabled (AI_EGRESS_DISABLED=1) — refused to call";

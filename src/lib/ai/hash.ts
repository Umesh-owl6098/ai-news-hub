import "server-only";
import { createHash } from "node:crypto";
import type { ArticleEnrichmentInput } from "@/lib/ai/types";

/**
 * Deterministic cache key for "would this produce the same enrichment
 * input as before?" — folds in every field that feeds the prompt, plus
 * the prompt version itself, so a prompt change invalidates every cached
 * enrichment without needing a separate migration/backfill step. Field
 * order is fixed (not just JSON.stringify(input)) so key ordering from an
 * upstream source can never silently change the hash.
 */
export function computeInputHash(input: ArticleEnrichmentInput, promptVersion: string): string {
  const canonical = JSON.stringify({
    v: promptVersion,
    title: input.title,
    sourceName: input.sourceName,
    summary: input.summary,
    authors: input.authors ?? [],
    tags: input.tags ?? [],
    repositoryFullName: input.repositoryFullName ?? null,
    owner: input.owner ?? null,
    language: input.language ?? null,
    // Spread contributes nothing when sourceContext is absent (the object
    // literal below is `{}`, and JSON.stringify drops undefined-valued
    // keys) — so every baseline (context-less) call keeps hashing
    // byte-identically to before this field existed, and cached baseline
    // rows from Step 11/12 remain valid cache hits. Only an actual
    // sourceContext value (Step 13's input-quality experiment) changes
    // the hash — correctly, since it changes what's actually sent to the
    // model.
    ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

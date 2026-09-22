import "server-only";
import { createHash } from "node:crypto";

/**
 * Deterministic cache key for "would this produce the same embedding
 * input as before?" — mirrors `hash.ts`'s `computeInputHash` for
 * enrichment. Folds in the normalized semantic document, the configured
 * embedding model identifier, and the embedding schema version; never a
 * generated/DB timestamp, never bookmark state. Field order is fixed
 * (not just `JSON.stringify`ing an arbitrary object) so key ordering can
 * never silently change the hash.
 *
 * Same semantic document + same model + same schema version → same hash.
 * Changed content, changed model, or a bumped schema version → changed
 * hash, making the item eligible for re-embedding.
 */
export function computeEmbeddingInputHash(semanticDocument: string, model: string, schemaVersion: number): string {
  const canonical = JSON.stringify({ v: schemaVersion, model, doc: semanticDocument });
  return createHash("sha256").update(canonical).digest("hex");
}

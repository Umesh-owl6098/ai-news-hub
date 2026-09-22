/**
 * Deterministic title normalization, shared by in-memory All-feed dedup
 * (lib/dedupe.ts) and the database layer's `normalized_title` column —
 * one definition so both stay consistent.
 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

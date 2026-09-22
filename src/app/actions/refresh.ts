"use server";

import { refreshAllSources, type RefreshSummary } from "@/lib/refreshService";

export interface RefreshSourcesActionResult {
  ok: boolean;
  summary: RefreshSummary | null;
  error?: string;
}

/**
 * The single UI entry point for an explicit refresh — calls the exact
 * same `refreshAllSources` the CLI script uses (see
 * `scripts/refresh-sources.ts`), so there is one refresh implementation,
 * never a UI copy and a CLI copy. Never throws a raw exception to the
 * browser: `refreshAllSources` already isolates every per-source failure
 * internally, so the only way this action itself fails is something
 * outside that (e.g. the process-local guard/promise machinery throwing,
 * which shouldn't happen in practice) — still guarded defensively.
 */
export async function refreshSourcesAction(): Promise<RefreshSourcesActionResult> {
  try {
    const summary = await refreshAllSources();
    return { ok: true, summary };
  } catch {
    return { ok: false, summary: null, error: "Couldn't refresh sources right now. Try again." };
  }
}

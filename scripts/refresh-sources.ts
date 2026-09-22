/**
 * Explicit, manual refresh of every configured source — Hacker News,
 * arXiv, GitHub, and each configured RSS publisher. Calls the exact same
 * `refreshAllSources` the UI's "Refresh sources" button uses (see
 * src/app/actions/refresh.ts) — one refresh implementation, reused, not
 * duplicated between CLI and UI.
 *
 *   npm run sources:refresh
 *
 * Never runs automatically (no scheduler, no cron) — this milestone is
 * about the refresh operation existing and being observable, not about
 * when it runs.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // No such file — fine.
  }
}

import { isDatabaseConfigured } from "@/db";
import { refreshAllSources } from "@/lib/refreshService";

async function main() {
  if (!isDatabaseConfigured()) {
    console.error("DATABASE_URL is not set — nothing to persist a refresh into.");
    process.exitCode = 1;
    return;
  }

  console.log("Refreshing all sources...\n");
  const summary = await refreshAllSources();

  let succeeded = 0;
  let failed = 0;
  for (const outcome of summary.outcomes) {
    if (outcome.status === "success") {
      succeeded++;
      console.log(`  ✓ ${outcome.sourceLabel.padEnd(24)} ${outcome.itemCount} item(s)`);
    } else {
      failed++;
      console.log(`  ✗ ${outcome.sourceLabel.padEnd(24)} ${outcome.errorCategory}: ${outcome.errorMessage}`);
    }
  }

  console.log(`\n${succeeded} succeeded, ${failed} failed. Started ${summary.startedAt}, finished ${summary.finishedAt}.`);
  if (failed > 0 && succeeded === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("sources:refresh failed:", error);
  process.exitCode = 1;
});

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // "server-only" throws unconditionally outside Next.js's own bundler
      // (which special-cases and no-ops it for Server Components); under
      // plain Node/Vite it just needs to be an inert module for tests.
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    // Integration test files share ONE physical ephemeral Postgres
    // database and scope their cleanup by a per-file source-key prefix
    // (e.g. "test:enrich:%", "evaltest:%"). That isolation only holds if
    // files run one at a time — a query that legitimately scans broadly
    // with no prefix filter (e.g. enrichRecentItems with no sourceType),
    // which is correct production behavior, can otherwise pick up rows
    // a DIFFERENT file's test left mid-flight. Discovered in Step 10 when
    // two integration files run in parallel produced flaky cross-file
    // contamination that neither file's own test order could reproduce.
    fileParallelism: false,
  },
});

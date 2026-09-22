import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

/**
 * Repository-level source_health tests against a real PostgreSQL instance
 * (Step 21). Skipped entirely unless DATABASE_URL is set, matching every
 * other *.integration.test.ts file's convention.
 *
 * Uses a "test:health:" sourceKey prefix — an ownership boundary that is
 * safe to delete outright in beforeAll/afterAll, unlike the real fixed
 * source identities ("hackernews", "rss:openai", ...) that refreshService
 * actually writes to (see refreshService.integration.test.ts, which
 * snapshots/restores those instead of deleting them).
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("source_health repository functions (real PostgreSQL)", () => {
  let db: typeof import("@/db");
  let repo: typeof import("@/db/repository");
  let schema: typeof import("@/db/schema");

  beforeAll(async () => {
    db = await import("@/db");
    repo = await import("@/db/repository");
    schema = await import("@/db/schema");
    await db.getDb()!.execute(sql`delete from source_health where source_key like 'test:health:%'`);
  });

  afterAll(async () => {
    await db.getDb()!.execute(sql`delete from source_health where source_key like 'test:health:%'`);
  });

  it("getAllSourceHealth omits a source key that was never attempted", async () => {
    const rows = await repo.getAllSourceHealth();
    expect(rows.some((r) => r.sourceKey === "test:health:never-touched")).toBe(false);
  });

  it("recordSourceHealthAttempt creates a row that stays never_run until an outcome is recorded", async () => {
    await repo.recordSourceHealthAttempt("test:health:a", "Test Source A");

    const [row] = await db
      .getDb()!
      .select()
      .from(schema.sourceHealth)
      .where(sql`source_key = 'test:health:a'`);

    expect(row).toBeDefined();
    expect(row.lastStatus).toBe("never_run");
    expect(row.lastAttemptedAt).not.toBeNull();
    expect(row.lastSucceededAt).toBeNull();
  });

  it("recordSourceHealthSuccess sets status/success timestamp/item count and clears error fields", async () => {
    // Seed a prior failure first, so this also proves success clears it.
    await repo.recordSourceHealthFailure("test:health:b", "Test Source B", "network_error", "boom");
    await repo.recordSourceHealthSuccess("test:health:b", "Test Source B", 7);

    const [row] = await db
      .getDb()!
      .select()
      .from(schema.sourceHealth)
      .where(sql`source_key = 'test:health:b'`);

    expect(row.lastStatus).toBe("success");
    expect(row.lastSuccessItemCount).toBe(7);
    expect(row.lastSucceededAt).not.toBeNull();
    expect(row.lastErrorCategory).toBeNull();
    expect(row.lastErrorMessage).toBeNull();
  });

  it("recordSourceHealthFailure never overwrites lastSucceededAt/lastSuccessItemCount from a prior success", async () => {
    await repo.recordSourceHealthSuccess("test:health:c", "Test Source C", 12);
    const [afterSuccess] = await db
      .getDb()!
      .select()
      .from(schema.sourceHealth)
      .where(sql`source_key = 'test:health:c'`);
    const succeededAt = afterSuccess.lastSucceededAt!.getTime();

    // Ensure a measurable time delta, then fail.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repo.recordSourceHealthFailure("test:health:c", "Test Source C", "timeout", "Test Source C timed out after 20000ms");

    const [afterFailure] = await db
      .getDb()!
      .select()
      .from(schema.sourceHealth)
      .where(sql`source_key = 'test:health:c'`);

    expect(afterFailure.lastStatus).toBe("failed");
    expect(afterFailure.lastErrorCategory).toBe("timeout");
    expect(afterFailure.lastErrorMessage).toBe("Test Source C timed out after 20000ms");
    // The load-bearing assertion (Step 21 §9/§4): a failed attempt must
    // not erase what the last successful attempt actually achieved.
    expect(afterFailure.lastSucceededAt!.getTime()).toBe(succeededAt);
    expect(afterFailure.lastSuccessItemCount).toBe(12);
    // But the attempt timestamp itself does move forward.
    expect(afterFailure.lastAttemptedAt!.getTime()).toBeGreaterThan(afterSuccess.lastAttemptedAt!.getTime());
  });

  it("truncates an overlong error message rather than storing it unbounded", async () => {
    const longMessage = "x".repeat(1000);
    await repo.recordSourceHealthFailure("test:health:d", "Test Source D", "unknown", longMessage);

    const [row] = await db
      .getDb()!
      .select()
      .from(schema.sourceHealth)
      .where(sql`source_key = 'test:health:d'`);

    expect(row.lastErrorMessage!.length).toBe(512);
  });

  it("getAllSourceHealth reflects independent rows per source key (no cross-source bleed)", async () => {
    await repo.recordSourceHealthSuccess("test:health:e1", "Test Source E1", 3);
    await repo.recordSourceHealthFailure("test:health:e2", "Test Source E2", "http_error", "Request failed (500)");

    const rows = await repo.getAllSourceHealth();
    const e1 = rows.find((r) => r.sourceKey === "test:health:e1");
    const e2 = rows.find((r) => r.sourceKey === "test:health:e2");

    expect(e1?.lastStatus).toBe("success");
    expect(e2?.lastStatus).toBe("failed");
    expect(e2?.lastErrorCategory).toBe("http_error");
  });
});

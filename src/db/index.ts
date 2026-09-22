import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Lazily-initialized, provider-agnostic Postgres connection. Reads only
 * `DATABASE_URL` — never a vendor-specific variable — so hosting can be
 * swapped without touching application code.
 *
 * Deliberately NOT created at module scope: constructing (or worse,
 * connecting) a client at import time would run during `next build`'s
 * static analysis/prerendering, which must succeed with no database
 * configured at all. `getDb()` is only ever called from request-time
 * repository functions.
 */
let cachedDb: PostgresJsDatabase<typeof schema> | null = null;
let cachedClient: ReturnType<typeof postgres> | null = null;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Returns the Drizzle client, or null if DATABASE_URL isn't set. Callers
 * (the repository layer) are responsible for falling back gracefully —
 * this never throws for "not configured," only for a genuinely malformed
 * connection string.
 */
export function getDb(): PostgresJsDatabase<typeof schema> | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  if (!cachedDb) {
    cachedClient = postgres(connectionString, {
      // Short-lived, low-concurrency connections suit a single-instance
      // personal app better than a large pool.
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    cachedDb = drizzle(cachedClient, { schema });
  }

  return cachedDb;
}

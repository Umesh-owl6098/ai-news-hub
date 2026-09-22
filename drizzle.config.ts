import { defineConfig } from "drizzle-kit";

// Only read at migration-generation/apply time (via the drizzle-kit CLI),
// never at app build or runtime — see src/db/index.ts for the app's own
// lazy, build-safe connection handling.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl ?? "postgres://placeholder:placeholder@localhost:5432/placeholder",
  },
});

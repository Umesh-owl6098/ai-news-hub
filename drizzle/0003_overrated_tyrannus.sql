-- PostgreSQL requires a generated column's expression to be IMMUTABLE.
-- The built-in array_to_string is only STABLE (a general caution for
-- polymorphic array functions, not because joining text[] with a fixed
-- separator is actually non-deterministic) — confirmed against a real
-- PostgreSQL 16 instance that the ADD COLUMN below fails with "generation
-- expression is not immutable" without this trivial wrapper.
CREATE OR REPLACE FUNCTION immutable_array_to_string(text[], text) RETURNS text AS $$
  SELECT array_to_string($1, $2)
$$ LANGUAGE sql IMMUTABLE STRICT;
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(source_name, '') || ' ' || replace(coalesce(repository_full_name, ''), '/', ' ') || ' ' || coalesce(immutable_array_to_string(tags, ' '), '')), 'B') ||
  setweight(to_tsvector('english', coalesce(summary, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(immutable_array_to_string(authors, ' '), '') || ' ' || coalesce(owner, '') || ' ' || coalesce(language, '')), 'D')
) STORED;--> statement-breakpoint
CREATE INDEX "feed_items_search_vector_idx" ON "feed_items" USING gin ("search_vector");
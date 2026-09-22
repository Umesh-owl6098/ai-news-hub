-- Step 17: required before the "vector" column type below can exist.
-- Feasibility confirmed against a real PostgreSQL 16 + pgvector 0.8.6
-- instance (pgvector/pgvector:pg16 image) before finalizing this
-- migration — see the Step 17 final report for the full evaluation.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "feed_item_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_item_id" integer NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model" varchar(128) NOT NULL,
	"embedding_version" integer NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feed_item_embeddings" ADD CONSTRAINT "feed_item_embeddings_feed_item_id_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."feed_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_item_embeddings_item_model_version_idx" ON "feed_item_embeddings" USING btree ("feed_item_id","provider","model","embedding_version");--> statement-breakpoint
-- Deliberately deferred to a CHECK constraint rather than a fixed
-- `vector(n)` column type: Step 17 does not choose an embedding model, so
-- the column itself stays dimension-agnostic, but every row's stored
-- vector must still genuinely match its own declared `dimensions` value.
-- `vector_dims` is IMMUTABLE (confirmed against pg_proc.provolatile),
-- so it is a valid CHECK expression.
ALTER TABLE "feed_item_embeddings" ADD CONSTRAINT "feed_item_embeddings_dimensions_check" CHECK (
  "dimensions" > 0 AND "dimensions" = vector_dims("embedding")
);
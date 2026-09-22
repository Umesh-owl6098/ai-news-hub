CREATE TABLE "article_enrichments" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_item_id" integer NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model" varchar(128) NOT NULL,
	"prompt_version" varchar(32) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"summary" text,
	"topics" text[],
	"relevance_score" real,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"error_code" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Explicit bounded state model, enforced at the database level (not
	-- just in application code) — see src/db/schema.ts ENRICHMENT_STATUSES
	-- / PROVIDER_ERROR_CODES, which must be kept in sync with these lists.
	CONSTRAINT "article_enrichments_status_check" CHECK ("status" IN ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "article_enrichments_error_code_check" CHECK ("error_code" IS NULL OR "error_code" IN ('not_configured', 'rate_limited', 'timeout', 'invalid_output', 'provider_error')),
	CONSTRAINT "article_enrichments_relevance_score_check" CHECK ("relevance_score" IS NULL OR ("relevance_score" >= 0 AND "relevance_score" <= 1))
);
--> statement-breakpoint
ALTER TABLE "article_enrichments" ADD CONSTRAINT "article_enrichments_feed_item_id_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."feed_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_enrichments_feed_item_id_idx" ON "article_enrichments" USING btree ("feed_item_id");--> statement-breakpoint
CREATE INDEX "article_enrichments_status_idx" ON "article_enrichments" USING btree ("status");
CREATE TABLE "source_health" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_key" varchar(64) NOT NULL,
	"source_label" varchar(128) NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_success_item_count" integer,
	"last_status" varchar(16) DEFAULT 'never_run' NOT NULL,
	"last_error_category" varchar(32),
	"last_error_message" varchar(512),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "source_health_source_key_idx" ON "source_health" USING btree ("source_key");
--> statement-breakpoint
-- Explicit bounded state (Step 21), enforced at the database level, mirroring
-- hn_discussion_context's status/consistency discipline (migration 0006).
ALTER TABLE "source_health" ADD CONSTRAINT "source_health_status_check" CHECK ("last_status" IN ('never_run', 'success', 'failed'));--> statement-breakpoint
ALTER TABLE "source_health" ADD CONSTRAINT "source_health_error_category_check" CHECK (
  "last_error_category" IS NULL OR "last_error_category" IN ('rate_limited', 'timeout', 'network_error', 'http_error', 'parse_error', 'database_error', 'unknown')
);--> statement-breakpoint
-- Error columns exist exactly when the last attempt failed — never a
-- leftover error on a since-succeeded source, never a "failed" status
-- with no explanation.
ALTER TABLE "source_health" ADD CONSTRAINT "source_health_error_consistency_check" CHECK (
  ("last_status" = 'failed' AND "last_error_category" IS NOT NULL) OR
  ("last_status" != 'failed' AND "last_error_category" IS NULL AND "last_error_message" IS NULL)
);
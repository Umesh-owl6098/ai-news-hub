ALTER TABLE "hn_discussion_context" ALTER COLUMN "normalized_context" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hn_discussion_context" ADD COLUMN "status" varchar(16) DEFAULT 'has_context' NOT NULL;--> statement-breakpoint
-- Explicit bounded state (Step 16), enforced at the database level: a row
-- can only ever be 'has_context' with real text, or 'no_context' with
-- none — never an ambiguous empty string, never both, never neither.
ALTER TABLE "hn_discussion_context" ADD CONSTRAINT "hn_discussion_context_status_check" CHECK ("status" IN ('has_context', 'no_context'));--> statement-breakpoint
ALTER TABLE "hn_discussion_context" ADD CONSTRAINT "hn_discussion_context_context_consistency_check" CHECK (
  ("status" = 'has_context' AND "normalized_context" IS NOT NULL) OR
  ("status" = 'no_context' AND "normalized_context" IS NULL)
);
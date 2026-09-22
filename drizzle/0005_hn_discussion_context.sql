CREATE TABLE "hn_discussion_context" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_item_id" integer NOT NULL,
	"normalized_context" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hn_discussion_context" ADD CONSTRAINT "hn_discussion_context_feed_item_id_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."feed_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hn_discussion_context_feed_item_id_idx" ON "hn_discussion_context" USING btree ("feed_item_id");
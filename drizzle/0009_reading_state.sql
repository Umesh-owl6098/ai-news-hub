CREATE TABLE "reading_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_item_id" integer NOT NULL,
	"queued_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reading_state" ADD CONSTRAINT "reading_state_feed_item_id_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."feed_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_state_feed_item_id_idx" ON "reading_state" USING btree ("feed_item_id");
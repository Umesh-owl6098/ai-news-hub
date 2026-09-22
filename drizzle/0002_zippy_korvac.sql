CREATE TABLE "bookmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_item_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_feed_item_id_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."feed_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_feed_item_id_idx" ON "bookmarks" USING btree ("feed_item_id");
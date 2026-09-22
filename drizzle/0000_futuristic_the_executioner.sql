CREATE TABLE "feed_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_key" varchar(512) NOT NULL,
	"source_type" varchar(32) NOT NULL,
	"source_id" varchar(128),
	"source_name" varchar(128) NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"normalized_title" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"discussion_url" text,
	"pdf_url" text,
	"score" integer,
	"comment_count" integer,
	"authors" text[],
	"tags" text[],
	"repository_full_name" varchar(256),
	"owner" varchar(128),
	"language" varchar(64),
	"stars" integer,
	"forks" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "feed_items_source_key_idx" ON "feed_items" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "feed_items_published_at_idx" ON "feed_items" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "feed_items_canonical_url_idx" ON "feed_items" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "feed_items_normalized_title_idx" ON "feed_items" USING btree ("normalized_title");--> statement-breakpoint
CREATE INDEX "feed_items_source_type_idx" ON "feed_items" USING btree ("source_type");
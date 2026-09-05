ALTER TABLE "releases" ADD COLUMN "image_unavailable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "image_checked_at" timestamp with time zone;
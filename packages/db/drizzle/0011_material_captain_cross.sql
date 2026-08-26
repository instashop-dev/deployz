ALTER TYPE "public"."failure_code" ADD VALUE 'REDIS_PROVISIONING_FAILED';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'REDIS_CONNECTION_FAILED';--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "redis_required" boolean DEFAULT false NOT NULL;
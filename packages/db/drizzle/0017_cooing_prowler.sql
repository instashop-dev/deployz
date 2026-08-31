CREATE TYPE "public"."cleanup_state" AS ENUM('SKIPPED_RELAY_OFFLINE', 'COMPLETE');--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'PURGE';--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "cleanup_state" "cleanup_state";
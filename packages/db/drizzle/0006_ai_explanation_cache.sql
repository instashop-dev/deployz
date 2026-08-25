CREATE TYPE "public"."ai_explanation_state" AS ENUM('PENDING', 'GENERATING', 'READY', 'FAILED');--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD COLUMN "ai_explanation_state" "ai_explanation_state" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD COLUMN "ai_explanation_what" text;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD COLUMN "ai_explanation_why" text;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD COLUMN "ai_explanation_fix" text;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD COLUMN "ai_explanation_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployment_jobs" ADD COLUMN "ai_explanation_generated_at" timestamp with time zone;
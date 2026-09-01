ALTER TYPE "public"."deployment_state" ADD VALUE 'WAITING_FOR_RELAY' BEFORE 'INSTALLING';--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "attempt_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "bootstrap_stack_name" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "install_started_at" timestamp with time zone;
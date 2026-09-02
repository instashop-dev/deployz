ALTER TYPE "public"."cleanup_state" ADD VALUE 'PURGE_FAILED' BEFORE 'COMPLETE';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'DOMAIN_OPERATION_TIMEOUT';--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "previous_installation_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "previous_bootstrap_stack_name" text;
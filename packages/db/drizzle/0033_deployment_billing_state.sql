CREATE TYPE "public"."deployment_type" AS ENUM('TEST', 'PRODUCTION');--> statement-breakpoint
CREATE TYPE "public"."deployment_billing_state" AS ENUM('NOT_STARTED', 'ACTIVE', 'STOPPED');--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "deployment_type" "deployment_type" DEFAULT 'PRODUCTION' NOT NULL;--> statement-breakpoint
UPDATE "deployments" SET "deployment_type" = 'TEST' WHERE "is_test_deployment" = true;--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN "is_test_deployment";--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "billing_state" "deployment_billing_state" DEFAULT 'NOT_STARTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "billing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "billing_stopped_at" timestamp with time zone;--> statement-breakpoint
UPDATE "deployments" SET "billing_state" = 'ACTIVE', "billing_started_at" = now() WHERE "deployment_type" = 'PRODUCTION' AND "state" IN ('HEALTHY','UPDATE_AVAILABLE','UPDATING');--> statement-breakpoint
UPDATE "deployments" SET "billing_state" = 'STOPPED', "billing_stopped_at" = COALESCE("deleted_at", now()) WHERE "deployment_type" = 'PRODUCTION' AND "state" IN ('DELETING','DELETED');

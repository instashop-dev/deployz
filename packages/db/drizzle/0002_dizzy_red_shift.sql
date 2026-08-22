CREATE TYPE "public"."build_status" AS ENUM('PENDING', 'BUILDING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('HEALTHY', 'DEGRADED', 'UNHEALTHY');--> statement-breakpoint
CREATE TYPE "public"."org_plan" AS ENUM('FREE', 'STARTER', 'PRO');--> statement-breakpoint
CREATE TYPE "public"."relay_status" AS ENUM('CONNECTED', 'DISCONNECTED', 'UNKNOWN');--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'AWS_PERMISSION_DENIED' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'STACK_CREATE_FAILED' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'DATABASE_CREATE_FAILED' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'DATABASE_CONNECTION_FAILED' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'IMAGE_PULL_FAILED' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'CONTAINER_START_FAILED' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'MISSING_SECRET' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."failure_code" ADD VALUE 'UNSUPPORTED_ARCHITECTURE' BEFORE 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."job_state" ADD VALUE 'QUEUED' BEFORE 'WAITING';--> statement-breakpoint
ALTER TYPE "public"."job_state" ADD VALUE 'SUCCESS' BEFORE 'FAILED';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'PREFLIGHT';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'HEALTH_CHECK';--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "plan" "org_plan" DEFAULT 'FREE' NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "container_port" integer;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "health_path" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "worker_command" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "database_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "storage_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "external_reference" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "build_status" "build_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "aws_account_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "current_release_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "previous_release_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "relay_status" "relay_status" DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "health_status" "health_status" DEFAULT 'HEALTHY' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_current_release_id_releases_id_fk" FOREIGN KEY ("current_release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_previous_release_id_releases_id_fk" FOREIGN KEY ("previous_release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;
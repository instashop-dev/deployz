CREATE TYPE "public"."billing_provider" AS ENUM('PADDLE');--> statement-breakpoint
CREATE TYPE "public"."billing_subscription_status" AS ENUM('ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."billing_event_processing_status" AS ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."billing_reconciliation_status" AS ENUM('SUCCEEDED', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" "billing_provider" DEFAULT 'PADDLE' NOT NULL,
	"provider_customer_id" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"status" "billing_subscription_status" NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"last_provider_event_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "billing_subscriptions_provider_subscription_id_unique" UNIQUE("provider_subscription_id")
);--> statement-breakpoint
CREATE TABLE "billing_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "billing_provider" DEFAULT 'PADDLE' NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"organization_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_status" "billing_event_processing_status" DEFAULT 'RECEIVED' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_provider_events_provider_event_id_unique" UNIQUE("provider_event_id")
);--> statement-breakpoint
CREATE TABLE "billing_reconciliation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"expected_deployment_quantity" integer NOT NULL,
	"provider_deployment_quantity" integer,
	"action" text NOT NULL,
	"status" "billing_reconciliation_status" NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_provider_events" ADD CONSTRAINT "billing_provider_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_events" ADD CONSTRAINT "billing_reconciliation_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "plan";--> statement-breakpoint
DROP TYPE "public"."org_plan";

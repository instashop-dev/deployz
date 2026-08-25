CREATE TYPE "public"."custom_domain_status" AS ENUM('PENDING', 'WAITING_FOR_DNS', 'CONFIGURING', 'ACTIVE', 'ERROR', 'REMOVING');--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'CONFIGURE_DOMAIN';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'REMOVE_DOMAIN';--> statement-breakpoint
CREATE TABLE "custom_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"hostname" text NOT NULL,
	"status" "custom_domain_status" DEFAULT 'PENDING' NOT NULL,
	"certificate_arn" text,
	"validation_name" text,
	"validation_value" text,
	"routing_target" text,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"check_cycle" integer DEFAULT 0 NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_active_hostname_idx" ON "custom_domains" USING btree ("hostname") WHERE "custom_domains"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_active_deployment_idx" ON "custom_domains" USING btree ("deployment_id") WHERE "custom_domains"."removed_at" is null;
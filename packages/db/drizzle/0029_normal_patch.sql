CREATE TYPE "public"."deployment_source" AS ENUM('manual', 'deploy_link');--> statement-breakpoint
CREATE TABLE "deploy_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_links_deployment_uidx" UNIQUE("deployment_id")
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source" "deployment_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "deploy_links" ADD CONSTRAINT "deploy_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_links" ADD CONSTRAINT "deploy_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_links" ADD CONSTRAINT "deploy_links_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_links" ADD CONSTRAINT "deploy_links_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;
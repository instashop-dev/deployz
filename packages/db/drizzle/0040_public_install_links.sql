ALTER TYPE "public"."deployment_source" ADD VALUE 'public_link';--> statement-breakpoint
CREATE TABLE "public_install_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "public_install_links" ADD CONSTRAINT "public_install_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD CONSTRAINT "public_install_links_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "public_install_link_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "confirm_key" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_public_install_link_id_public_install_links_id_fk" FOREIGN KEY ("public_install_link_id") REFERENCES "public"."public_install_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "public_install_links_one_live_per_application_uidx" ON "public_install_links" ("application_id") WHERE "public_install_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_public_install_confirm_uidx" ON "deployments" ("public_install_link_id","confirm_key") WHERE "deployments"."public_install_link_id" IS NOT NULL AND "deployments"."confirm_key" IS NOT NULL;

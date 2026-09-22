CREATE TYPE "public"."region_selection" AS ENUM('customer', 'legacy_publisher_fixed');--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "recommended_region" "region";--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "region_selection" "region_selection" DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD CONSTRAINT "public_install_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP INDEX "public_install_links_one_live_per_application_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "public_install_links_one_live_per_application_uidx" ON "public_install_links" ("application_id") WHERE "public_install_links"."revoked_at" IS NULL AND "public_install_links"."customer_id" IS NULL;--> statement-breakpoint
ALTER TABLE "deploy_links" ADD COLUMN "region_selection" "region_selection" DEFAULT 'legacy_publisher_fixed' NOT NULL;

CREATE TYPE "public"."infrastructure_size_tier" AS ENUM('small', 'medium', 'large');--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "default_size_profile" "infrastructure_size_tier" DEFAULT 'small' NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "minimum_size_profile" "infrastructure_size_tier" DEFAULT 'small' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "recommended_size_profile" "infrastructure_size_tier";--> statement-breakpoint
ALTER TABLE "public_install_links" ADD COLUMN "minimum_size_profile" "infrastructure_size_tier";--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD COLUMN "size_profile" "infrastructure_size_tier";

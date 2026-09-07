DROP TABLE "usage_records";--> statement-breakpoint
DROP TABLE "subscriptions";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "stripe_customer_id";--> statement-breakpoint
DROP TYPE "public"."subscription_status";

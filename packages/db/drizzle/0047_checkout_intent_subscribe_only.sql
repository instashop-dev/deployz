ALTER TABLE "billing_checkout_intents" ALTER COLUMN "application_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ALTER COLUMN "region" DROP NOT NULL;

ALTER TABLE "deployments" ADD COLUMN "relay_version" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "bootstrap_version" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "relay_capabilities" jsonb;
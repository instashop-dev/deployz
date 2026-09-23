ALTER TABLE "applications" ADD COLUMN "environment_settings" jsonb;--> statement-breakpoint
ALTER TABLE "application_configs" ADD COLUMN "encrypted_value" text;

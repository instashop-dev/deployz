ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "environment_settings" jsonb;--> statement-breakpoint
ALTER TABLE "application_configs" ADD COLUMN IF NOT EXISTS "encrypted_value" text;

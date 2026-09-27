ALTER TABLE "deployments" ADD COLUMN "spec_v2" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "infra_version" SET DEFAULT 'dynamic-compiler-v2';

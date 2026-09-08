ALTER TABLE "organization" ADD COLUMN "included_production_deployments" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_included_production_deployments_range" CHECK ("included_production_deployments" >= 0 AND "included_production_deployments" <= 10000);

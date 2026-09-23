CREATE TABLE "pending_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" uuid NOT NULL,
	"customer_id" uuid,
	"deployment_id" uuid,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"encryption_context" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivered_deployment_id" uuid,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);--> statement-breakpoint
ALTER TABLE "pending_secrets" ADD CONSTRAINT "pending_secrets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_secrets" ADD CONSTRAINT "pending_secrets_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_secrets" ADD CONSTRAINT "pending_secrets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_secrets" ADD CONSTRAINT "pending_secrets_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_pending_secrets_staged" ON "pending_secrets" ("application_id","customer_id","key") NULLS NOT DISTINCT WHERE "pending_secrets"."deployment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_pending_secrets_bound" ON "pending_secrets" ("deployment_id","key") WHERE "pending_secrets"."deployment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_pending_secrets_expiry" ON "pending_secrets" ("expires_at");
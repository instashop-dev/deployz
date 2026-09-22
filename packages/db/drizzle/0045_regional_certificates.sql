ALTER TABLE "customers" ADD COLUMN "dns_scope" text DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_dns_scope_unique" UNIQUE("dns_scope");--> statement-breakpoint
CREATE TABLE "customer_regional_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"aws_account_id" text NOT NULL,
	"region" "region" NOT NULL,
	"certificate_domain" text NOT NULL,
	"certificate_arn" text,
	"certificate_status" "regional_certificate_status" DEFAULT 'REQUESTING' NOT NULL,
	"validation_record_name" text,
	"validation_record_value" text,
	"validation_record_type" text,
	"cloudflare_record_id" text,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"requested_at" timestamp with time zone,
	"validation_dns_ready_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"check_cycle" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_by" text
);--> statement-breakpoint
ALTER TABLE "customer_regional_certificates" ADD CONSTRAINT "customer_regional_certificates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_regional_certificates" ADD CONSTRAINT "customer_regional_certificates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_regional_certificates_scope_uidx" ON "customer_regional_certificates" ("customer_id","aws_account_id","region");

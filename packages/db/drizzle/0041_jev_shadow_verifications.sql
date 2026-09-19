CREATE TABLE "jev_shadow_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"analysis_commit_sha" text NOT NULL,
	"evidence_schema_version" integer NOT NULL,
	"decision_set_version" integer NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"deployz_requirements" jsonb NOT NULL,
	"jev_result" jsonb,
	"ok" boolean NOT NULL,
	"error_kind" text,
	"latency_ms" integer,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "jev_shadow_verifications" ADD CONSTRAINT "jev_shadow_verifications_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;

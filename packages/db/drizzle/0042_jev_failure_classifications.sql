CREATE TABLE "jev_failure_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"deployment_stage" text NOT NULL,
	"evidence_schema_version" integer NOT NULL,
	"decision_set_version" integer NOT NULL,
	"deployz_failure_code" text NOT NULL,
	"classification" jsonb,
	"ok" boolean NOT NULL,
	"error_kind" text,
	"latency_ms" integer,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

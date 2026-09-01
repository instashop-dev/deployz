CREATE TABLE "deployment_stack_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"job_id" uuid,
	"provider_event_id" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"logical_resource_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_status" text NOT NULL,
	"resource_status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_stack_events" ADD CONSTRAINT "deployment_stack_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_stack_events" ADD CONSTRAINT "deployment_stack_events_job_id_deployment_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."deployment_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_stack_events_dedupe_uidx" ON "deployment_stack_events" USING btree ("deployment_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "deployment_stack_events_deployment_idx" ON "deployment_stack_events" USING btree ("deployment_id","event_at");
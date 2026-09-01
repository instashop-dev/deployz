CREATE TYPE "public"."infrastructure_component_kind" AS ENUM('application', 'database', 'storage', 'cache', 'endpoint', 'network', 'monitoring', 'container_registry', 'other');--> statement-breakpoint
CREATE TYPE "public"."infrastructure_component_status" AS ENUM('pending', 'provisioning', 'ready', 'updating', 'deleting', 'failed', 'retained', 'removed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."infrastructure_lifecycle" AS ENUM('delete', 'retain', 'snapshot', 'conditional');--> statement-breakpoint
CREATE TYPE "public"."infrastructure_resource_role" AS ENUM('primary', 'supporting');--> statement-breakpoint
CREATE TABLE "deployment_resources" (
	"deployment_id" uuid NOT NULL,
	"stack_id" text NOT NULL,
	"logical_resource_id" text NOT NULL,
	"physical_resource_id" text,
	"resource_type" text NOT NULL,
	"resource_status" text NOT NULL,
	"resource_status_reason" text,
	"component_kind" "infrastructure_component_kind" NOT NULL,
	"resource_role" "infrastructure_resource_role" NOT NULL,
	"lifecycle_policy" "infrastructure_lifecycle" NOT NULL,
	"last_updated_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deployment_resources_deployment_stack_logical_unique" UNIQUE("deployment_id","stack_id","logical_resource_id")
);
--> statement-breakpoint
ALTER TABLE "deployment_resources" ADD CONSTRAINT "deployment_resources_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_resources_deployment_idx" ON "deployment_resources" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployment_resources_deployment_kind_idx" ON "deployment_resources" USING btree ("deployment_id","component_kind");
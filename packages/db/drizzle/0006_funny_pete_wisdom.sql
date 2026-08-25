-- §46 health_status gains UNKNOWN.
--
-- NOT `ALTER TYPE ... ADD VALUE`. Postgres refuses to USE a value added that
-- way until the adding transaction has committed, and drizzle applies every
-- pending migration inside ONE transaction — so 0007, which sets the column
-- default to 'UNKNOWN', failed with 55P04 whenever this file was still
-- pending alongside it. That is every fresh database and every deployment
-- that had not yet caught up.
--
-- Replacing the type instead lifts the restriction: values of a type CREATEd
-- in the current transaction are usable in that same transaction.
ALTER TYPE "public"."health_status" RENAME TO "health_status_old";--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "health_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "health_status" TYPE "public"."health_status" USING "health_status"::text::"public"."health_status";--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "health_status" SET DEFAULT 'HEALTHY';--> statement-breakpoint
DROP TYPE "public"."health_status_old";

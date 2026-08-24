--> §12 relay enrollment + §36 uniqueness + §46 honest defaults.

-- Deduplicate before the constraints below can be created. Only rows that
-- nothing points at are removed: an accidental second "Choose" on the same
-- repository, or a re-entered release version, neither of which was ever
-- deployed. A duplicate that IS referenced fails the ALTER TABLE below on
-- purpose — that is a data decision a person has to make, not a migration.
DELETE FROM "releases" r
WHERE EXISTS (
    SELECT 1 FROM "releases" keep
    WHERE keep."application_id" = r."application_id"
      AND keep."version" = r."version"
      AND keep."created_at" < r."created_at"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "deployments" d
    WHERE d."current_release_id" = r."id" OR d."previous_release_id" = r."id"
  );--> statement-breakpoint

DELETE FROM "applications" a
WHERE EXISTS (
    SELECT 1 FROM "applications" keep
    WHERE keep."organization_id" = a."organization_id"
      AND keep."repo_full_name" = a."repo_full_name"
      AND keep."created_at" < a."created_at"
  )
  AND NOT EXISTS (SELECT 1 FROM "deployments" d WHERE d."application_id" = a."id")
  AND NOT EXISTS (SELECT 1 FROM "releases" rel WHERE rel."application_id" = a."id")
  AND NOT EXISTS (SELECT 1 FROM "application_configs" c WHERE c."application_id" = a."id");--> statement-breakpoint

ALTER TABLE "releases" ALTER COLUMN "release_status" SET DEFAULT 'READY';--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "health_status" SET DEFAULT 'UNKNOWN';--> statement-breakpoint

-- installation_id becomes the id the RELAY mints for itself, so it is unknown
-- until enrollment.
ALTER TABLE "deployments" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "deployments" ADD COLUMN "install_link_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
-- Backfilled with a fresh value per row, then the default is dropped: every
-- future insert supplies its own code so the column can never silently
-- collide on a shared default.
ALTER TABLE "deployments" ADD COLUMN "enrollment_code" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "enrollment_code" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "enrollment_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "relay_token_hash" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "relay_bound_at" timestamp with time zone;--> statement-breakpoint

-- Existing deployments were already reachable by their installation_id, so
-- treat them as enrolled rather than orphaning a live relay.
UPDATE "deployments" SET "enrollment_used_at" = "created_at", "relay_bound_at" = "created_at"
WHERE "installation_id" IS NOT NULL;--> statement-breakpoint

-- A deployment that never checked in has no observed health.
UPDATE "deployments" SET "health_status" = 'UNKNOWN' WHERE "last_health_at" IS NULL;--> statement-breakpoint

ALTER TABLE "applications" ADD CONSTRAINT "applications_org_repo_uidx" UNIQUE("organization_id","repo_full_name");--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_application_version_uidx" UNIQUE("application_id","version");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_install_link_id_unique" UNIQUE("install_link_id");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_enrollment_code_unique" UNIQUE("enrollment_code");

-- Existing rows may already violate one-active-per-deployment (the pre-index
-- race this migration closes). Keep the newest active mutating job per
-- deployment and cancel the rest, so the unique index below can build.
UPDATE "deployment_jobs" SET "state" = 'CANCELLED', "finished_at" = now(), "result" = '{"cancelledBy":"one-active-job-migration"}'::jsonb
WHERE "state" IN ('REQUESTED', 'QUEUED', 'WAITING', 'RUNNING')
  AND "type" IN ('INSTALL', 'DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'CONFIG_UPDATE', 'DESTROY', 'MIGRATION', 'INFRA_UPGRADE', 'PURGE')
  AND "id" NOT IN (
    SELECT DISTINCT ON ("deployment_id") "id" FROM "deployment_jobs"
    WHERE "state" IN ('REQUESTED', 'QUEUED', 'WAITING', 'RUNNING')
      AND "type" IN ('INSTALL', 'DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'CONFIG_UPDATE', 'DESTROY', 'MIGRATION', 'INFRA_UPGRADE', 'PURGE')
    ORDER BY "deployment_id", "created_at" DESC
  );--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_jobs_one_active_mutating_uidx" ON "deployment_jobs" USING btree ("deployment_id") WHERE "deployment_jobs"."state" IN ('REQUESTED', 'QUEUED', 'WAITING', 'RUNNING') AND "deployment_jobs"."type" IN ('INSTALL', 'DEPLOY_RELEASE', 'ROLLBACK', 'RESTART', 'CONFIG_UPDATE', 'DESTROY', 'MIGRATION', 'INFRA_UPGRADE', 'PURGE');
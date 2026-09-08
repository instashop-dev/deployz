CREATE UNIQUE INDEX "deployments_one_active_test_per_application_uidx" ON "deployments" ("application_id") WHERE "deployment_type" = 'TEST' AND "state" <> 'DELETED';

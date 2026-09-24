# Operating the control plane

How the Deployz control plane is deployed and configured, how customer
templates are published, and how a Region is enabled. Architecture context:
[`../architecture.md`](../architecture.md). Decision record for the CI-only
rule: [`../decisions/deploy-gate.md`](../decisions/deploy-gate.md).

## Deploys run in CI, never from a laptop

`.github/workflows/deploy-api.yml` deploys the `Deployz` CDK stack (VPC, RDS,
API Lambda, SQS queue and worker Lambda, the CodeBuild/ECR release pipeline,
the KMS key, the public template bucket) on every push to `main` that touches
`apps/api`, `packages/{cdk,db,contracts,analysis,relay}` or the lockfile, and
on demand from the Actions tab. One deploy runs at a time. It:

1. supplies the Lambda's **entire** environment from repository secrets and
   variables (`collectEnvVars()` in `packages/cdk/src/deployz-stack.ts`
   replaces the deployed environment; a key that is absent is deleted from
   the running function);
2. refuses to deploy when any of the required values is blank
   (`CDK_DEFAULT_ACCOUNT`, `API_CERTIFICATE_ARN`, `BETTER_AUTH_SECRET`, the
   GitHub OAuth and App keys, the SES keys, the four Cloudflare keys);
3. refuses when `PADDLE_API_KEY` is set but the other Paddle values are not;
4. builds, runs `cdk deploy Deployz`, then polls
   `https://api.deployz.dev/health/ready` (database and schema) for up to
   five minutes. `CREATE_COMPLETE` alone can hide an initialization crash
   (a failed migration, a missing KMS key ARN); the readiness poll is the
   real check;
5. optionally republishes the bootstrap template to every deployable Region
   (see below).

`packages/cdk/bin/deployz.ts` refuses to run outside GitHub Actions. To
inspect the stack locally:

```bash
pnpm --filter @deployz/cdk exec cdk diff Deployz -c local=true
```

The `local` context flag also re-enables `deploy`; it exists for previewing,
not shipping.

`deploy-web.yml` builds `apps/web` into a container and ships it to the
Lightsail container service behind `app.deployz.dev`. Neither deploy
workflow waits for CI; when validating a production change, record the SHA
and confirm both deploy runs finished.

Known gap in the trigger paths: `deploy-api.yml` does not list
`packages/copy-map/**` although the API bundles it, and `deploy-web.yml`
does not list `packages/contracts/**` although the web app bundles it. A
change to only one of those packages does not redeploy the service that
uses it; run the workflow from the Actions tab in that case.

There are no CloudWatch alarms and no paging on the control plane. The SQS
dead-letter queue (three delivery attempts, three-day retention) is
inspected by hand when a job goes missing; the worker's structured logs
name the message id.

## Configuration keys

Names only; values live in GitHub secrets and variables. Everything the API
reads is validated in `apps/api/src/env.ts`.

| Group | Keys | Notes |
| --- | --- | --- |
| Public URLs | `API_URL`, `WEB_URL`, `MARKETING_URL`, `COOKIE_DOMAIN`, `BETTER_AUTH_URL`, `EMAIL_FROM` | Hard-coded in the workflow |
| API domain | `API_DOMAIN_NAME`, `API_CERTIFICATE_ARN` | Both required or the `api.deployz.dev` mapping is removed. The certificate is requested out of band; the Cloudflare `api` CNAME must be DNS-only or TLS fails with 525. |
| Auth and GitHub | `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_INSTALL_URL` | The GitHub App's **Setup URL** must be `<WEB_URL>/github/setup` with "Redirect on update" enabled; that page binds the installation to the vendor's organisation and offers sign-in when needed. |
| Email | `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY` | Organisation membership email only |
| Default HTTPS | `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ZONE_NAME`, `DEPLOYZ_DEFAULT_HOSTNAME_PREFIX`, `CLOUDFLARE_ZONE_EDIT_API_TOKEN` | [`../networking-and-https.md`](../networking-and-https.md) |
| AI | `AI_GATEWAY_BASE_URL`, `AI_PROVIDER_API_KEY`, `AI_MODEL` (optional), `AI_GATEWAY_TOKEN` (only for an authenticated gateway) | Unset is safe: deterministic copy is served |
| Customer templates | `BOOTSTRAP_TEMPLATE_URL` (variable), `DEPLOYABLE_AWS_REGIONS` (variable), `BOOTSTRAP_REPUBLISH` (variable) | See *Publishing customer templates* |
| Release builds | `DOCKERHUB_SECRET_NAME` (variable) | [`../docker-hub-credentials.md`](../docker-hub-credentials.md). Unresolvable name fails every build; empty means unset. |
| Billing | `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_PLATFORM`, `PADDLE_PRICE_DEPLOYMENT`, `PADDLE_ENVIRONMENT` (variable, defaults to `sandbox`), `BILLING_ENFORCEMENT` (variable; `off` pauses the production-deployment subscription gate) | [`../billing/paddle-billing.md`](../billing/paddle-billing.md) |
| Secrets | `DEPLOYZ_KMS_KEY_ARN` | Set by CDK from the stack's own key; the API fails to start without it |
| Set by CDK | `DATABASE_URL`, `JOB_QUEUE_URL`, `DEPLOYZ_ECR_REPOSITORY_NAME`, `BUILD_LOG_GROUP_NAME`, `SOURCE_BUCKET`, `BUILD_PROJECT_NAME` | Not in the workflow |

`TEAM_ADMIN_EMAILS` and `GITHUB_FIXTURE_MODE` are local-development only and
are ignored or excluded inside Lambda. Production Team Admin access is
`user.platform_role = 'ADMIN'`, set by SQL
([`../admin/team-admin.md`](../admin/team-admin.md)). The `JEV_*` keys are
allowlisted but never set; Jev is off in production by decision.

## Database migrations

Every Lambda cold start (API and worker) runs the bundled drizzle migrations
(`packages/cdk/src/lambda/db-connection.ts`). A new migration under
`packages/db/drizzle/` needs a matching hand-written import in that file;
`packages/cdk/test/lambda-migrations.test.ts` fails when one is missing. A
migration that cannot apply kills Lambda initialization: `/health/ready`
fails, the deploy workflow fails, and warm containers keep the cached
failure until they are recycled.

## Publishing customer templates

The customer-side artifacts are published by hand, in this order, after
`pnpm build`:

1. `pnpm --filter @deployz/cdk run publish:application` — uploads the four
   application template variants to the legacy template bucket under
   `application/v1/…`. The application templates contain no Lambda code, so
   they stay single-Region and are fetched by CloudFormation over HTTPS.
2. `pnpm --filter @deployz/cdk run publish:bootstrap` — synthesizes the
   bootstrap stack once, then publishes a per-Region template plus the relay
   Lambda's asset zips into every `deployz-templates-<region>` bucket, and
   verifies each Region (bucket Region, objects present, `ValidateTemplate`,
   URL reachability). It fails if any Region fails, because a half-published
   set leaves Regions failing with an S3 `PermanentRedirect` at stack
   creation. It prints the `BOOTSTRAP_TEMPLATE_URL` and
   `DEPLOYABLE_AWS_REGIONS` values to set as repository variables.

Why per Region: a Lambda must read its code from a bucket in its own Region.
The regional buckets must already exist with public read; the publisher
verifies, it does not create.

The relay code that drives every install ships inside the bootstrap
template's assets. A relay fix reaches a customer only after
`publish:bootstrap` for that Region **and** a bootstrap stack update (a new
Quick Create) on the customer side. With the repository variable
`BOOTSTRAP_REPUBLISH=on`, the deploy workflow republishes to every Region in
`DEPLOYABLE_AWS_REGIONS` after each successful API deploy; the deploying
identity needs `s3:GetBucketLocation`, `s3:PutObject` and
`cloudformation:ValidateTemplate` on every bucket for that step to succeed.

Until `BOOTSTRAP_TEMPLATE_URL` is set, the API returns no Quick Create URL
and the install page says no template has been published. A Region that is
not in `DEPLOYABLE_AWS_REGIONS` is rejected at deployment creation. When the
variable is unset entirely the API falls back to `us-east-1` only; when it
is set but empty, no Region is installable. The live values of these
variables (and of `BOOTSTRAP_REPUBLISH`, `PADDLE_ENVIRONMENT`,
`BILLING_ENFORCEMENT`, `DOCKERHUB_SECRET_NAME`) are held in the GitHub
repository settings, not in this repository: read them with
`gh variable list`.

## Enabling a Region

1. Create the `deployz-templates-<region>` bucket with public read.
2. Run `publish:bootstrap` with that Region included
   (`BOOTSTRAP_PUBLISH_REGIONS`).
3. Add the Region to the `DEPLOYABLE_AWS_REGIONS` repository variable and
   redeploy the API.

The Region must be one of the 17 in `SUPPORTED_AWS_REGIONS`
(`packages/contracts/src/index.ts`). Customer accounts need quota for one
VPC, one NAT gateway and one Elastic IP per deployment in that Region
(default quota five), and Fargate vCPU quota (as low as six on a new
account).

## Release builds

The CodeBuild project (`packages/cdk/src/pipeline/build-pipeline.ts`) builds
the vendor's repository tarball (fetched by the worker with a GitHub App
token and staged in the private source bucket) into the shared, immutable
ECR repository `deployz-images`, tagged `<applicationId>-<version>`, and
pins the digest on the release. Docker Hub pulls are anonymous unless
`DOCKERHUB_SECRET_NAME` is set; rate-limit failures are retried three times
(60 s, 180 s, 480 s) and classified `build_registry_rate_limited`. Builds
that stay `BUILDING` for 30 minutes are settled by the worker's sweep.
Failed builds keep their CodeBuild log; the API serves the last 3000 lines,
redacted, to the owning organisation. There is no ECR lifecycle policy, so
image storage grows until images are removed by hand; a release whose image
is deleted becomes `UNAVAILABLE` and can no longer be deployed.

## Watchdog and sweeps

The worker Lambda runs every 15 minutes: stuck-job reconciliation, relay
liveness (CONNECTED → DISCONNECTED after 15 minutes without a heartbeat),
stuck builds, billing reconciliation, a count-only config-secret inventory
(`watchdog:config-secret-inventory`; `stub` and `other` must be zero in
production), and expiry of pending secrets. Timings and rules are in
[`../deployment-resilience.md`](../deployment-resilience.md).

## Local development

No Docker or Postgres is needed: without `DATABASE_URL` the API uses a
file-backed PGlite store at `packages/db/.pgdata`. `pnpm install`,
`pnpm build`, then `pnpm dev` (or `pnpm e2e` for the simulated suite).
`pnpm build` must not run while `next dev` is running (it corrupts
`apps/web/.next`), and the API imports workspace packages from `dist/`, so
rebuild after editing a package the API or the relay harness depends on.

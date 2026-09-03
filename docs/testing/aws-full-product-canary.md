# Full-product AWS canary (transient install)

The manual, real-AWS walk of the whole product: vendor → install link →
customer Quick Create → relay → CloudFormation → HEALTHY → release deploy →
disconnect → purge, against the **deployed** control plane
(`https://app.deployz.dev` / `https://api.deployz.dev`) and the test AWS
account. It is the only check that exercises the published bootstrap and
application templates, the relay Lambda that ships to customers, and the
control plane together. Everything below was validated on 2026-09-02/03.

Use it to validate a release, or after a change to the relay, the templates,
the install/deploy state machine, or the publish tooling. For everything
else use the simulated suite (`pnpm e2e`); see
[`ai-agent-testing-guide.md`](ai-agent-testing-guide.md).

## 1. Fix the commit under test

- Production is whatever `main` was last pushed: `deploy-api.yml` and
  `deploy-web.yml` run on every push. Record `git rev-parse origin/main`
  **and** confirm both deploy runs for that SHA succeeded
  (`gh run list --workflow deploy-api.yml --limit 3`; the API Lambda's
  `LastModified` must be after the run).
- Another workstream may merge while you test. Re-record the SHA whenever
  `origin/main` moves and note which findings were observed on which SHA.

## 2. Publish the customer templates from that commit

The deploy workflows never publish templates. What a customer downloads is
whatever `publish:application` / `publish:bootstrap` last uploaded, so a
canary on stale templates tests old relay code. Compare
`packages/cdk/artifacts/bootstrap-template-v1.json` (relay asset hash in
`RelayFunction.Code.S3Key`) with the published object before assuming they
match.

```bash
pnpm build
APP_IMAGE_REPOSITORY=<account>.dkr.ecr.us-east-1.amazonaws.com/deployz-images \
APP_IMAGE_DIGEST=sha256:<digest> APP_PRESET=documenso AWS_REGION=us-east-1 \
  pnpm --filter @deployz/cdk run publish:application
BOOTSTRAP_PUBLISH_REGIONS=us-east-1 BOOTSTRAP_LEGACY_BUCKET_REGION=us-east-1 AWS_REGION=us-east-1 \
  pnpm --filter @deployz/cdk run publish:bootstrap
```

The bootstrap publisher prints the `BOOTSTRAP_TEMPLATE_URL` it wrote; it must
equal the deployed API Lambda's `BOOTSTRAP_TEMPLATE_URL` environment variable
(`aws lambda get-function-configuration`). Without
`BOOTSTRAP_PUBLISH_REGIONS`/`BOOTSTRAP_LEGACY_BUCKET_REGION` the publisher
fans out to every `deployz-templates-<region>` bucket and fails closed if
one is missing — none of those buckets exist yet, so the two variables are
the production recipe until they do.

Republish after every merge that touches `packages/relay/src`,
`packages/cdk/src/bootstrap`, or `packages/cdk/src/application` — including
merges that land mid-canary.

## 3. Baseline and resource ledger

Before creating anything, capture what exists so cleanup can be proven by
difference, not by tags alone (the relay stack creates untagged and
retained resources):

```bash
R=us-east-1
aws cloudformation list-stacks --region $R --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE DELETE_FAILED CREATE_IN_PROGRESS DELETE_IN_PROGRESS --query 'StackSummaries[].[StackName,StackStatus]' --output text
aws rds describe-db-instances --region $R --query 'DBInstances[].[DBInstanceIdentifier,DBInstanceStatus,DeletionProtection]' --output text
aws rds describe-db-subnet-groups --region $R --query 'DBSubnetGroups[].DBSubnetGroupName' --output text
aws elasticache describe-replication-groups --region $R --query 'ReplicationGroups[].ReplicationGroupId' --output text
aws s3api list-buckets --query 'Buckets[].Name' --output text
aws ecs list-clusters --region $R --query clusterArns --output text
aws elbv2 describe-load-balancers --region $R --query 'LoadBalancers[].LoadBalancerName' --output text
aws ec2 describe-vpcs --region $R --query 'Vpcs[].[VpcId,Tags[?Key==`Name`].Value|[0]]' --output text
aws ec2 describe-nat-gateways --region $R --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text
aws secretsmanager list-secrets --region $R --query 'SecretList[].Name' --output text
aws logs describe-log-groups --region $R --query 'logGroups[].logGroupName' --output text
aws iam list-roles --query 'Roles[?contains(RoleName, `eployz`)].RoleName' --output text
aws resourcegroupstaggingapi get-resources --region $R --tag-filters Key=deployz:installation --query 'ResourceTagMappingList[].ResourceARN' --output text
```

Keep a ledger file. Add every identifier the moment it appears: bootstrap
stack name and installation id (stack output `InstallationId`), the relay
Lambda name, `deployz-app-<installation prefix>` stack, its outputs (RDS
identifier, bucket, cache replication group, cluster, ALB), the ECR tag of
any release you build, and anything you create for diagnosis (probe
Lambdas, roles). The control-plane resources (`Deployz` stack, its RDS,
`deployz-images`, the template buckets, `deployz-e2e-usw2-progress`) are
never canary-owned.

## 4. The walk

1. **Vendor** (`app.deployz.dev`, an org with the GitHub App installed): add
   the application, wait for analysis, confirm "Ready to deploy" and that
   the Configuration form shows the detected container port, health path and
   migration command you expect. Re-analyse after an analysis change lands
   (`ANALYSIS_VERSION` bumps also re-run stale verdicts on the next open).
2. **Deployment**: Deployments → Create Customer Deployment (use a
   throwaway customer name/email; a failed creation now shows the API's
   reason and does not duplicate the customer). Record the install link and
   deployment id.
3. **Customer**: open the install link, press *Deploy to AWS*, land on the
   CloudFormation Quick Create page (stack name
   `deployz-bootstrap-<app>-<8 chars>`, template + control-plane URL +
   enrollment code prefilled), tick the IAM acknowledgement, *Create stack*.
   Bootstrap takes ~3 minutes; the relay's first scheduled poll (5-minute
   EventBridge rate) registers and claims INSTALL.
4. **Provisioning**: the application stack appears as
   `deployz-app-<installation prefix>`; with Redis required it takes ~10
   minutes. The relay watches for 3 minutes per invocation, writes its SSM
   pending marker (`/deployz/<installationId>/pending-command`) and resumes
   on later polls. Watch for `relay:command-deferred` then
   `relay:command-resumed`/`relay:command-verified` in the relay log group
   (`/aws/lambda/<bootstrap stack>--RelayFunction…`).
5. **Healthy**: the deployment reaches HEALTHY only after a heartbeat with
   full task counts, healthy ALB targets and a successful HTTP probe. Check
   the app yourself: `curl http://<ALB DNS>/api/health` (use curl — the ALB
   is plain HTTP until the HTTPS endpoint is active, and HTTPS-First
   browsers refuse http). Since Phase 11, HTTPS is provisioned automatically
   on the Deployz-owned default hostname (`<deploymentId>.apps.deployz.dev`,
   `DEPLOYZ_DNS_ZONE_ID`) with zero customer DNS; a customer custom domain,
   when added, keeps precedence. The vendor detail shows *Open app* and the
   URL once the deployment is READY.
6. **Inventory**: `aws cloudformation list-stack-resources` per-type counts
   must equal the vendor *Infrastructure* section / `deployment_resources`
   rows (50 for the Redis variant of the documenso preset).
7. **Release + deploy**: Application → Releases → Create Release (CodeBuild
   builds the repository's Dockerfile, ~7 minutes for documenso; the image
   tag equals the version). *Deploy Update* on the deployment; the relay
   runs the migration command as a one-off ECS task (`sh -c <command>`)
   before the service update. Watch the stopped task's exit code and the
   app log group. A failed update must leave the deployment at
   UPDATE_AVAILABLE/HEALTHY with the old task definition still PRIMARY.
8. **Disconnect**, then **Purge** from the vendor UI (the customer-facing
   *Security details* page states what each retains). After Disconnect the
   deployment leaves Home and the live fleet: open Deployments → status
   *Removed* (or the "N removed deployments…" link) to reach it. Disconnect deletes the
   application stack but retains RDS, its credential secrets, the S3 bucket
   and the subnet group (plus the subnet/DB security group/VPC its ENI
   blocked); Purge removes those. The bootstrap/relay stack is deleted by
   the customer in CloudFormation — the pages tell them so; in a canary you
   delete it yourself (`aws cloudformation delete-stack`).

## 5. Cleanup verification

Re-run the baseline commands and diff against the ledger. Specifically:

- The bootstrap stack is not deleted by Purge (see §6): delete
  `deployz-bootstrap-<app>-<8 chars>` yourself with
  `aws cloudformation delete-stack` as the customer would from the console,
  then delete its relay log group.
- No `deployz-app-*` or `deployz-bootstrap-*` stack in any status other
  than DELETE_COMPLETE (`list-stacks` without a status filter shows deleted
  history for 90 days — that is fine).
- No RDS instance, RDS subnet group, ElastiCache replication group, ALB,
  ECS cluster (ACTIVE), VPC, NAT gateway, or EIP that was not in the
  baseline. Retained-by-design resources only disappear after Purge.
- Secrets Manager: no `DatabaseSecret…`, `DatabaseUrlSecret…`,
  `AppConfigSecret…` or `RelayCredential…` from the canary. Purged secrets
  sit in *scheduled for deletion* — `list-secrets
  --include-planned-deletion` shows them; that is the expected end state.
- Log groups: the application log group is deleted with the stack, but the
  relay function's log group
  (`/aws/lambda/<bootstrap stack>--RelayFunction…`) and the install-id /
  log-retention Lambda groups survive stack deletion — delete them
  explicitly.
- SSM: no `/deployz/<installationId>/*` parameter.
- ECR: delete the release image tag you built
  (`aws ecr batch-delete-image --image-ids imageTag=<version>`).
- Anything you created to diagnose (probe Lambdas, roles, their log groups).
- `aws resourcegroupstaggingapi get-resources --tag-filters
  Key=deployz:installation,Values=<installationId>` returns nothing except
  INACTIVE ECS clusters/task definitions, which the tagging API keeps
  listing after deletion and which cost nothing.

## 6. Failure cases seen on real AWS (and what now guards them)

| Symptom | Cause | Guard |
| --- | --- | --- |
| Install reported *failed* after exactly 3 minutes while the stack keeps creating; relay error "could not record that it must report back" | SSM pending marker exceeded 4 KB once the INSTALL payload carried the manifest | Marker stores merged parameters, not the manifest; oversize/write failures are logged (`relay:pending-marker-too-large`, `relay:pending-write-failed`); relay tests defer a production-size payload |
| Healthy app analysed as NOT_COMPATIBLE (dev compose file, `@azure/*`/`@google-cloud/*` SDKs) | Over-broad §11.4 rejection signals | Compose files under development/test/example paths ignored; cloud rejections need deployment files; fixture test in `packages/analysis/test/phase7.test.ts` |
| Health path detected as a source-file path (`/apps/remix/routes/api+/health`) | File-route derivation ignored router roots and remix flat-route markers | `deriveHealthPathFromFile` tests for Remix/SvelteKit/monorepo shapes |
| Failed update marks the deployment FAILED although the old version serves | `currentReleaseId` is null for template-image installs | A SUCCEEDED install counts as a running workload (`failure-semantics.test.ts`, `worker.test.ts`) |
| Migration task exits 1: "Cannot find module '/app/…/prisma'" | Command run as a whitespace split on a node-entrypoint image | Migration runs as `sh -c <command>`; the release's own command outranks the manifest snapshot |
| Diagnostics blame a rolled-back resource for a relay-side fault | Relay hardcodes STACK_CREATE_FAILED | `RELAY_STATE_WRITE_FAILED` (DEPLOYZ_ACTION) refinement |
| `publish:bootstrap` refuses to run | 17 regional buckets required | `BOOTSTRAP_PUBLISH_REGIONS` + `BOOTSTRAP_LEGACY_BUCKET_REGION` |
| Create-deployment form says "Try again in a moment" and duplicates the customer | Generic catch, customer created before the deployment | Server message + readiness link; customer reused on retry (`e2e/create-deployment.spec.ts`) |
| Deferred command never resumes (Disconnect stuck RUNNING, stack DELETE_FAILED with nobody retrying) | SecureString marker read without `WithDecryption` — ciphertext parsed as "nothing pending" | Reads decrypt; unreadable markers log `relay:pending-marker-unreadable` (`pending.test.ts`) |
| No Purge control after a normal Disconnect; API 409 NOT_PURGE_ELIGIBLE | Purge was wired for the force-complete case only | Any DELETED deployment is purgeable until cleanupState COMPLETE; the page says what stays behind |
| Disconnected deployment unreachable (Home hides it, list shows the empty state) | Fleet list excluded DELETED with no other entry point | *Removed* status filter + "N removed deployments may still have retained resources" link |
| Purge "succeeds" but the relay stack stays and keeps polling | `DescribeStacks` on the bootstrap stack is AccessDenied (tag condition the stack cannot satisfy), mapped to "already gone" | Purge reports `connectorStackRetained`; vendor page + install link tell the customer to delete `deployz-bootstrap-…` in CloudFormation |
| VPC, private subnet, DB security group and RDS subnet group survive Disconnect + Purge | Retained-RDS ENI blocks the subnet → DELETE_FAILED cascade; purge swept only RDS/cache/S3/secrets | Tag-verified network + subnet-group sweep with matching relay IAM (`purge.test.ts`) |

## 7. Driving the dashboard from automation

The dashboard is a Next.js app whose pages stream inside a Suspense
boundary that React reveals on `requestAnimationFrame`. A browser tab that
is not visible never fires it, so every page except Home stays on its
skeletons and no API calls run — it looks like an outage. Check
`document.visibilityState` before filing a defect, keep the driven tab in the
foreground, and prefer client-side navigation (clicking the app's own links)
over reloading a hidden tab.

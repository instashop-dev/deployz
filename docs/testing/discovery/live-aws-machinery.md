# Discovery: existing live-AWS test machinery

Point-in-time investigation (2026-09-02) feeding the canary/fresh mode design
(design decision D5). Paths/lines as of branch
`claude/deployz-phase1-e2e-testing-d6512e`; they can drift. For the resulting
modes, see `../aws-canary.md` and `../aws-fresh.md`.

## 1. `packages/cdk/test/golden-path-live-aws.test.ts` (506 lines)

Header (lines 1-31): "§67 Golden Path E2E — LIVE AWS proof (Phase 4: steps 11-13, 16, 18)": synth → `cdk deploy` → verify CREATE_COMPLETE → verify relay Lambda Active → verify `deployz:installation` tags → `cdk destroy`.

**Gate**: line 316 — `const liveAws = process.env.DEPLOYZ_LIVE_AWS === '1' ? describe : describe.skip;` — silent skip, no fail-fast message.

**Constants** (41-56): `STACK_NAME = 'DeployzBootstrap'`; `REGION = process.env.AWS_REGION ?? 'us-east-1'`; `APP_CMD = 'tsx bin/bootstrap.ts'`; `REDIS_STACK_NAME = 'DeployzApplicationRedisLive'`.

**cdk invocation** (58-74): `run(cmd)` = `spawnSync(cmd, { shell: true, timeout: 600_000 })` (shell:true required on Windows for the pnpm.cmd shim); `cdk(args)` = `pnpm --filter @deployz/cdk exec cdk ...` with space-containing args quoted; `awsCli(args)` shells the real `aws` CLI for Lambda-config/tag lookups.

**Block A — live AWS bootstrap golden path** (318-371): `cdk deploy --app "tsx bin/bootstrap.ts" --require-approval never` → `describeStacks` asserts CREATE_COMPLETE → `aws lambda get-function-configuration` asserts relay Active + `DEPLOYZ_INSTALLATION_ID` env UUID → `resourcegroupstaggingapi get-resources` on `deployz:installation` asserts ≥3 ARNs (lambda/secretsmanager/events) → `cdk destroy --force` + poll to DELETE_COMPLETE (30×5s). Creates/destroys the whole `DeployzBootstrap` stack. Cleanup relies on the teardown being the 4th `it` in the block (Vitest still runs it if an earlier `it` fails, but an aborted suite leaves the stack); no `CleanupRegistry` use here.

**Block B — live AWS Redis cache provisioning** (373-461): synthesizes a standalone `ApplicationStack` (`expressMode:false, allowInsecureHttp:true, redisRequired:true`) and calls `aws.cloudFormation.createStack` directly (no bundled Lambda assets, so no publisher gap). 15-25 min to CREATE_COMPLETE (RDS dominates), real AWS charges; **RDS is `RemovalPolicy.RETAIN` — deletion orphans the RDS instance, manual cleanup required**. Requires `DEPLOYZ_LIVE_IMAGE_REPOSITORY` + `DEPLOYZ_LIVE_IMAGE_DIGEST` (`requireLiveImage()`, 124-138, throws in `beforeAll` naming the missing vars — without a pullable image the ECS circuit breaker rolls the whole stack back ~15-25 min in). Polls: stack 180×10s; `waitForCacheAvailable` 60×10s (throws on `create-failed`/`incompatible-parameters`); delete + `waitForStackGone` 60×10s. **No try/finally — a mid-test failure leaves the stack live.**

**Block C — installation verification (live)** (463-506): `INSTALLATION = process.env.DEPLOYZ_LIVE_INSTALLATION_ID ?? 'c2dca2bb-a733-470d-8ef0-8e96bc889442'` — a real installation provisioned 2026-08-27, treated as a standing fixture. VERIFY-only: `verifyInstallation({cfn: createCloudFormationReader(REGION), installationId})` asserts checks `stack-exists, stack-complete, stack-tagged, compute, ingress, database, storage` all pass; a fake stack name fails verification. Creates/destroys nothing.

**Fake-path unit tests** (199-314) for `waitForCacheAvailable`/`synthRedisApplicationTemplate`/`requireLiveImage` run in every `pnpm vitest run` with no AWS.

## 2. `packages/cdk/src/integration/` harness

- **`runner.ts`** — `runSuite(deps, config)` (196-309): synth → publish → deploy-bootstrap → wait-first-contact → deploy-application → verify-healthy → teardown (`SuitePhase`, 26-33). All AWS via the injectable `AwsClients`; `synth`/`publish` injected too. Registers each created stack with a `CleanupRegistry` immediately after `createStack` (233-238, 260-265) so `runWithTeardown`'s finally guarantees deletion. `classifyFailure` maps SCP denials to `AWS_SCP_BLOCKED`. `verifyHealthy` (156-176) = ECS runningCount===desiredCount AND every ALB target healthy. **Currently exercised only by mock-seamed tests** (`integration-harness.test.ts`, `golden-path-e2e.test.ts`) — no live-AWS run drives `runSuite`; the live test file bypasses it entirely. So today no live run exercises bootstrap→first-contact→application→verify-healthy as one flow.
- **`teardown.ts`** — `CleanupRegistry` (63-123): reverse-creation-order, best-effort cleanups, structured `TeardownResult`; `runWithTeardown` (133-142) always tears down in finally. Pure TS.
- **`scp-blocked.ts`** — `isScpBlocked` (85-99) requires both "is not authorized to perform:" and "explicit deny in a service control policy"; `extractBlockedAction` regexes the `service:Action`.
- **`aws-clients.ts`** — the injectable `AwsClients` (244-258; `elastiCache` optional) with real `createAwsClients()` (314-433, lazy per-region SDK clients, standard credential chain — no explicit credential fail-fast). `seedTestAccount` (458-470): `sts.getCallerIdentity` + SCP list = the "is the test account ready" gate.
- **`regions.ts`** — `SPOT_REGIONS = ['us-east-1','eu-west-1','ap-southeast-1']`; `allRegions()` = the 17-region allowlist. Live test hardcodes one region.

## 3. `packages/cdk/scripts/audit-deployment.mjs`

`pnpm --filter @deployz/cdk audit:deployment --installation <uuid> [--region] [--stack-name] [--claimed HEALTHY] [--redis]`. Requires `pnpm build` first (imports compiled relay dist; documented, not enforced). Parses via `node:util` parseArgs; missing `--installation` or parse failure → usage + exit 2. Region default: `--region` → `AWS_REGION` → `us-east-1`. Calls the same `verifyInstallation`; prints PASS/FAIL per check + VERDICT. Exit codes: 0 verified, 1 not verified, 2 usage. If `--claimed HEALTHY|UPDATE_AVAILABLE` and verification fails, the verdict names the contradiction. Read-only; creates/destroys nothing.

## 4. Tagging / isolation

Tag keys in the codebase: `deployz:component`, `deployz:application`, `deployz:vendor`, `deployz:installation`. **No DeployzEnvironment/TestMode-style tag exists** — test and customer resources are tagged identically today.

- Bootstrap stack (`bootstrap-stack.ts`): installationId minted at deploy time by a CFN Custom Resource (578, `getAttString('InstallationId')`) — never pre-chosen by a test; `deployz:component=bootstrap` (1163); `deployz:installation` on every taggable resource (1176); optional `deployz:application`/`deployz:vendor` (1190/1205); IAM provisioner policies conditioned on `aws:ResourceTag/deployz:installation` + `aws:RequestTag/deployz:installation`; relay Lambda env `DEPLOYZ_INSTALLATION_ID` (1132); `InstallationId` CfnOutput (1232-1235).
- Application stack (`application-stack.ts`): same four tags (1119/1145/1174/1203); `applicationId`/`vendorId`/`installationId` are **optional constructor props** (170-179) a test can set to arbitrary strings.
- `verify.ts` check `stack-tagged` (206-221): `stack.tags['deployz:installation']` strict-equals the expected id — a same-named stack for another installation fails.
- `purge.ts` (100, 112-119, 197-200): refuses to delete any stack/resource whose `deployz:installation` tag mismatches; S3 ownership verified in code via GetBucketTagging.

Implication: the only per-run identity primitive is the CFN-minted `deployz:installation` UUID; canary/fresh isolation needs distinguishing stack names or additional tags supplied at create time (e.g. via `cdk deploy --tags` or ApplicationStack props) — and destructive cleanup must key on ids captured at creation, never name patterns.

## 5. Publish flow / BOOTSTRAP_TEMPLATE_URL / live-install workflow

Order dependency: **application template publishes before bootstrap** (the bootstrap template's `ApplicationTemplateUrl` default points at it).

- `publish-application.mjs`: requires `APP_IMAGE_REPOSITORY` + `APP_IMAGE_DIGEST` (exit 1 with circuit-breaker warning if missing); optional `APP_PRESET` (`documenso` only); `TEMPLATE_BUCKET` defaults from the control-plane stack's `-TemplateBucket` export. Publishes the base AND Redis-variant application templates. Single-region (CFN fetches app templates over HTTPS). Prints the follow-up `publish:bootstrap` command.
- `publish-bootstrap.mjs`: publishes to **every** supported region's pre-existing `deployz-templates-<region>` public bucket (a Lambda must read code from its own region — S3 PermanentRedirect otherwise); verifies each region (bucket region, objects, Code.S3Bucket, URL reachability, ValidateTemplate) and fails closed; prints the `DEPLOYABLE_AWS_REGIONS` value to set on the control plane.
- `BOOTSTRAP_TEMPLATE_URL`: API env var; unset ⇒ `quickCreateUrl: null` from the install API.
- Human live-install workflow today: build+push a pullable image → `publish:application` → `publish:bootstrap` → set `DEPLOYABLE_AWS_REGIONS`+`BOOTSTRAP_TEMPLATE_URL` on the control plane → install-link Quick Create flow in a customer account → relay registers → normal INSTALL/verify machinery. No runbook doc exists in docs/ beyond the discovery folder.

## 6. Credentials/config + fail-fast points

- `DEPLOYZ_LIVE_AWS=1` — master gate; silent skip without it.
- AWS credentials — standard SDK v3 chain; no explicit validation (absent creds surface as thrown SDK errors).
- `AWS_REGION` — defaults `us-east-1` everywhere.
- `DEPLOYZ_LIVE_IMAGE_REPOSITORY`/`DIGEST` — genuine fail-fast in `beforeAll` for the Redis block only.
- `DEPLOYZ_LIVE_INSTALLATION_ID` — optional, silently defaults to the standing installation.
- `pnpm build` first — documented, not enforced (module-not-found otherwise).
- Real `aws` CLI on PATH — needed by the bootstrap block; no explicit check.
- CI sets AWS creds but never `DEPLOYZ_LIVE_AWS` — live blocks are manual/local only; no canary workflow exists.
- New (this branch): `scripts/e2e.mjs` refuses canary/fresh without `DEPLOYZ_E2E_ALLOW_REAL_AWS=1`, before anything spawns.

## 7. Unique-ID / stack-name conventions

- `DEFAULT_BOOTSTRAP_STACK_NAME = 'deployz-bootstrap'`, `DEFAULT_APPLICATION_STACK_NAME = 'deployz-app'` (`packages/contracts/src/index.ts:791,825`).
- The live test uses its own hardcoded literals `DeployzBootstrap` / `DeployzApplicationRedisLive` — fixed, not per-run unique; concurrent or un-torn-down runs collide. The `cdk deploy` shellout has no stack-name override; the name comes from `bin/bootstrap.ts`'s construct id.
- `installationId` cannot be pre-chosen for bootstrap deploys (CFN mints it); the standalone `ApplicationStack` accepts one as a prop.
- No `attemptNumber`-style per-run uniqueness token exists in this machinery (the deployments table's attemptNumber is a control-plane concept, not used here).

## 8. Persistent-canary-like state

- The standing installation `c2dca2bb-a733-470d-8ef0-8e96bc889442` (default of `DEPLOYZ_LIVE_INSTALLATION_ID`) is the de facto persistent canary: verify-only consumers are Block C and `audit-deployment.mjs`.
- CREATE-and-destroy consumers: Block A (bootstrap stack) and Block B (Redis application stack, RDS orphaned by design).
- No scheduled workflow, cron, or periodic health check runs any of this — all manual.

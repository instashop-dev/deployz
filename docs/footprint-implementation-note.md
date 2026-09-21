# Implementation note — Deployment Footprint + AWS cost visibility

Internal Phase 0 note for the `deployment-footprint-aws-pricing` branch.
Written after tracing analysis → requirements → config → install → relay →
provisioning → inventory → vendor/customer UI. states the sources of truth,
the gaps, the chosen model, the UI integration points, and the rollout risks.

## 1. Current infrastructure sources of truth

| Value | Deciding place |
| --- | --- |
| Database / Redis / storage required | Frozen `DeploymentManifest` (`deployments.desiredState`) — the single requirement source (`packages/contracts/src/manifest.ts`) |
| Template variant (4 profiles) | `infrastructureProfileForManifest` → `resolveApplicationTemplateUrl` (`packages/contracts/src/index.ts`); relay installs a published variant |
| Component list + destroy lifecycle | `INFRASTRUCTURE_COMPONENTS` (`packages/contracts/src/components.ts`); `lifecycle-parity.test.ts` pins it to the templates' `DeletionPolicy` |
| Customer-facing resource catalog | `AWS_RESOURCES` (`packages/contracts/src/aws-resources.ts`), same parity test |
| What INSTALL/UPDATE/DESTROY does | `buildInstallPlan` / `buildUpdatePlan` / `buildDestroyPlan` (`packages/contracts/src/plan.ts`), served at `/api/applications/:id/plan` and `/api/deployments/:id/plan`; public install + install + deploy pages render this plan |
| Compute sizing (web/worker Fargate CPU/MiB, desiredCount) | literals in `packages/cdk/src/application/application-stack.ts` (`taskCpu ?? 256`, `taskMemoryMiB ?? 512`, worker fixed 256/512 × 1) |
| Database sizing | literals in `application-stack.ts` (db.t4g.micro, Postgres 16, 20 GB) |
| Cache sizing | literals in `application-stack.ts` (`cache.t4g.micro` valkey, single node) |
| Region | `deployments.region` (17-region allowlist in contracts) |
| Inventory | persisted CloudFormation inventory compared against the catalog by `GET /api/deployments/:id/infrastructure` (`compareInfrastructureExpectations`); vendor `InfrastructureSummary` renders it |
| Retention | DESTROY retains database + credentials + stored files; PURGE deletes them (Phase 9 RETAIN decision) |

## 2. Gaps found

1. **Sizing exists only inside CDK.** No UI, plan, or payload states the
   resolved size (db.t4g.micro, 20 GB, 0.25 vCPU / 512 MiB). Display can
   drift from CloudFormation because nothing shares the values.
2. **No workload concept.** The stack provisions a web service (and, since
   Stage B, an optional worker service), but plans/catalogs speak in
   "components"; the worker is invisible outside CDK.
3. **No cost estimate anywhere.**
4. **No materiality split.** `AWS_RESOURCES` mixes material rows (NAT, ALB)
   with plumbing (IAM, log groups) in one list; the primary footprint view
   needs the material subset only.
5. **No planned-vs-deployed labeling** of what the infrastructure will be.

## 3. Proposed canonical footprint model (implemented)

Extend the existing plan architecture — do not build a parallel system.

- New `packages/contracts/src/footprint.ts`:
  - `DEPLOYMENT_SIZING` — the ONE sizing table. `application-stack.ts`
    imports it, so the template and the display share values. A parity test
    pins the table to the four committed template artifacts (same pattern as
    `lifecycle-parity.test.ts`), so drift fails CI.
  - `Workload` / `ManagedResource` / `DeploymentFootprint` (zod-validated,
    versioned `version: 1`). Generic model: `role`, `category`, `service`
    keys; PostgreSQL/Redis/Fargate are registered handlers, not UI cases.
  - `resolveDeploymentFootprint({ manifest, region, infraVersion })` — a
    registry of capability handlers (web workload, worker workload,
    rds-postgres, elasticache-valkey, s3, alb, nat-gateway). Handlers own
    requirement rule, defaults, sizing, lifecycle, and pricing key.
    Lifecycle reuses `INFRASTRUCTURE_COMPONENTS` — no second lifecycle table.
- New `packages/contracts/src/pricing.ts`: `estimateFootprintCost(footprint)`
  — per-service adapters, region factor table, ranges rounded to whole
  dollars (totals to $5), `complete`/`pricingStatus`/`usageDependent`.
  Pure; unknown services degrade to `unavailable`; nothing throws.
- `DeploymentPlan` gains optional `footprint` + `costEstimate` (additive,
  backward-compatible): one derivation input per response, so plan, sizing,
  and estimate cannot disagree. No endpoint signature changes.
- **Historical footprint:** derived, not persisted. The frozen manifest +
  `deployments.region` + `infraVersion` fully determine it, and the parity
  test pins sizing to the immutable published templates of that
  `infraVersion`. Ceiling: a second sizing generation would need a
  per-`infraVersion` sizing registry (post-MVP; marked in code).

## 4. Existing UI surfaces extended (no new pages)

- Vendor application page (`dashboard/applications/[id]`): "Infrastructure"
  footprint summary above the existing "AWS infrastructure details"
  disclosure. No cost on the vendor side (kept secondary per MVP).
- Customer install page (`install/[installLinkId]`): "Planned
  infrastructure" summary + "Estimated AWS infrastructure" block inside the
  existing "Deployz will create" section.
- Public install flow (`public-install-flow.tsx`) and deploy link page
  (`deploy/[publicId]`): same two blocks; cost only when the server knows
  the region.
- Install progress (`install-progress.tsx`): same summary labeled
  "Deployed infrastructure" once the deployment is READY.
- Vendor deployment detail already reconciles planned vs actual
  (`InfrastructureSummary` + inventory); left as-is (lightweight by design).

## 5. API/schema/migration impact

- `deploymentPlanSchema`: two optional fields added. Old web + new API and
  vice versa stay compatible (fields optional; components render nothing
  when absent).
- No database migration. No endpoint changes. No relay changes.

## 6. Rollout risks

1. **Plan tests assert exact shapes** — updated for the two new fields
   (mechanical).
2. **Pricing realism** — numbers are coarse, heavily rounded, and labeled
   approximate; region factors are coarse buckets. Risk accepted for MVP;
   the structure allows per-region table refinement without UI changes.
3. **Sizing table edit without template republish** — blocked by the parity
   test, not by convention.
4. **Worker provisioning exists in the stack but no generic template
   publishes it** — the footprint resolves `worker` only from
   `manifest.worker.command`; no behavior change.

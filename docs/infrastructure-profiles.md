# Infrastructure profiles and versioning

The immutable infrastructure-size profile registry
(`packages/contracts/src/profile.ts`) is the single source of truth for the
AWS sizing of a deployment's application stack. It is deliberately separate
from the graph-shaping `InfrastructureProfile` (`{ postgres, redis }`) that
selects the template variant: the graph profile decides *what* components
exist, the size profile decides *how big* they are.

## Published profiles

| Key | Label | Workload | Database | Cache |
| --- | --- | --- | --- | --- |
| `small-v1` | Small | 0.25 vCPU / 512 MiB × 1 | `db.t4g.micro`, 20 GB (max 100 GB) | `cache.t4g.micro` × 1 |

`small-v1` is the only published profile and reproduces the pre-registry
sizing exactly. Engine/version stay manifest-driven constants (PostgreSQL 16,
Valkey), never profile fields.

## Resolution

- Footprint, plan and cost resolve from **frozen manifest + Region + profile
  id/version + infrastructure version** (`resolveDeploymentFootprint`,
  `buildInstallPlan`, `buildUpdatePlan`, `buildDestroyPlan`).
- Every new deployment freezes its profile in `deployments.desired_state` as
  `{ id, version }` (written once at creation; `apps/api/src/deploy-links.ts`).
- Existing deployments have no stored reference and resolve safely to
  `small-v1` (`resolveStoredInfrastructureSizeProfile`).
- Profiles are immutable: a published `id`+`version` never changes.

## Parity

`sizing-parity.test.ts` (`packages/cdk/test`) pins `small-v1` to the four
committed application templates, and `application-stack.ts` provisions from
the resolved profile. Editing a sizing value without republishing the
templates fails CI.

## Future work (deferred, not MVP)

A topology-changing `minimal` profile (fewer AZs, no NAT gateway, smaller
instance classes, or dropping RDS) requires a **new infrastructure version**
and a **security/cost review** before it can ship — it is not a new entry in
this registry alone, because a `minimal` profile changes the template resource
graph, which the four committed templates do not express. `large` is likewise
deferred. When either ships, add it to `INFRASTRUCTURE_SIZE_PROFILES` as a new
immutable version and republish the matching templates; do not edit
`small-v1`.

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
- The public plan preview resolves a profile by id:
  `GET /api/public-install/:linkId/plan?profile=small` (version 1 today);
  an unknown id is a 422, never a guess. Only `small` is published, so no
  profile selector is rendered anywhere.

## Plan resolution by profile id

`GET /api/public-install/:linkId/plan?region=…&profile=small` resolves the
footprint, plan, and server-side pricing by profile id. Today the only
valid id is `small` (which resolves to `small-v1`); an unknown profile id
returns `422 UNKNOWN_PROFILE`. An undeployable Region returns *Estimate
unavailable* rather than a numeric cost. The same resolution path serves
the vendor application page and the customer install page, so the two can
never disagree about what a deployment costs in a given Region.

## Legacy deployments

A deployment created before the profile registry has no stored
`infrastructureProfile` reference. `resolveStoredInfrastructureSizeProfile`
returns `small-v1` for these rows, so the footprint, plan, and cost are
unchanged from the pre-registry sizing. No migration is needed.

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

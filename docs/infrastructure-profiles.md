# Infrastructure profiles, footprint and cost

The immutable infrastructure-size profile registry
(`packages/contracts/src/profile.ts`) is the single source of truth for the
AWS sizing of a deployment's application stack. It is deliberately separate
from the graph-shaping `InfrastructureProfile` (`{ postgres, redis }`) that
selects the template variant ([`architecture.md`](architecture.md#application-template-selection)):
the graph profile decides *what* components exist, the size profile decides
*how big* they are.

## Published profiles

| Key | Label | Workload | Database | Cache |
| --- | --- | --- | --- | --- |
| `small-v1` | Small | 0.25 vCPU / 512 MiB × 1 task | `db.t4g.micro`, 20 GB (autoscaling to 100 GB) | `cache.t4g.micro` × 1 |

`small-v1` is the only published profile. Engine and version stay
manifest-driven constants (PostgreSQL 16, Valkey), never profile fields.
Values the templates fix regardless of profile: two AZs, one NAT gateway,
single-AZ RDS with 7-day backups, one cache node.

## Resolution

- Footprint, plan and cost resolve from **frozen manifest + Region + profile
  id/version + infrastructure version** (`resolveDeploymentFootprint`,
  `buildInstallPlan`, `buildUpdatePlan`, `buildDestroyPlan`).
- Every new deployment freezes its profile in `deployments.desired_state` as
  `{ id, version }`, written once at creation.
- A deployment created before the registry has no stored reference and
  resolves to `small-v1` (`resolveStoredInfrastructureSizeProfile`); no
  migration is needed.
- Profiles are immutable: a published `id` + `version` never changes.
- `GET /api/public-install/:linkId/plan?region=…&profile=small` resolves the
  footprint, plan and server-side pricing by profile id; an unknown id is
  `422 UNKNOWN_PROFILE`, never a guess. Only `small` is published, so no
  profile selector is rendered anywhere. The same resolution serves the
  vendor application page and the customer install page, so the two never
  disagree about what a deployment costs in a Region.

## Footprint and cost estimate

`packages/contracts/src/footprint.ts` derives a versioned
`DeploymentFootprint` (workloads and managed resources with role, category,
service, sizing and lifecycle) from the manifest, the Region and the profile,
reusing `INFRASTRUCTURE_COMPONENTS` for lifecycle rather than a second
table. `packages/contracts/src/pricing.ts` turns it into a monthly AWS cost
estimate: per-service adapters, coarse Region factors, ranges rounded to
whole dollars (totals to $5), with `complete` / `pricingStatus` /
`usageDependent` flags; an unknown service degrades to *unavailable*,
nothing throws. Both ride on `DeploymentPlan` as optional `footprint` and
`costEstimate` fields, so plan, sizing and estimate come from one derivation
per response.

The footprint is **derived, never persisted**: the frozen manifest, the
deployment's Region and the infrastructure version fully determine it, and
the parity test pins sizing to the immutable published templates of that
version. Pricing is deliberately approximate and labelled as such; the
customer install page shows it per Region, the vendor page shows the
footprint without cost. An undeployable Region shows *Estimate unavailable*
rather than a number.

## Parity

`packages/cdk/test/sizing-parity.test.ts` pins `small-v1` to the four
committed application templates. Editing a sizing value without
republishing the templates fails CI. Note that the CDK construct
synthesizes from the default profile; the frozen profile reaches
CloudFormation only through the published artifacts, which is correct while
one profile exists.

## Future work (deferred, not MVP)

A topology-changing `minimal` profile (fewer AZs, no NAT gateway, smaller
instance classes, or dropping RDS) requires a **new infrastructure version**
and a **security/cost review** before it can ship; it is not a new entry in
this registry alone, because it changes the template resource graph, which
the four committed templates do not express. `large` is likewise deferred.
When either ships, add it to `INFRASTRUCTURE_SIZE_PROFILES` as a new
immutable version and republish the matching templates; do not edit
`small-v1`. A second sizing generation also needs a per-version sizing
registry for historical footprints.

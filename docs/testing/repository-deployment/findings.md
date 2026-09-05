# Stage B findings registry

A finding is a systemic behaviour, never one repository's failure. Ids are
stable (`DEPLOY-001`, `DEPLOY-002`, …). Every result in `runs/` that a
finding explains references it in `findingIds`; the summary counts
repositories per finding.

Vocabulary (see `README.md`): the failure stage names where the funnel
stopped; the root cause names the first responsible layer. Resolution is
one of `FIXED`, `MVP_CAPABILITY_GAP`, `CORRECTLY_UNSUPPORTED`,
`REPO_CONFIGURATION`, `UPSTREAM_REPO_FAILURE`, `DEFERRED_WITH_REASON`, or
`OPEN` while work is in progress.

| Id | Stage | Root cause | Resolution | Affected |
| --- | --- | --- | --- | --- |
| DEPLOY-001 | INFRA_ERROR | DEPLOYZ_BUG | FIXED (pending deploy) | every non-Documenso application (by inspection; Wave 1 measures it) |

---

## DEPLOY-001 — A fresh install runs the template-pinned image, not the application's release

**Stage** INFRA_ERROR (the install stack cannot stabilise) · **Root cause**
DEPLOYZ_BUG · **Resolution** FIXED (pending deploy) · **Found** Phase 0, by
inspection of the deployed templates (2026-09-05).

**Behaviour.** The application template's container image is fixed when the
template is published (`packages/cdk/scripts/publish-application.mjs`:
`APP_IMAGE_REPOSITORY` / `APP_IMAGE_DIGEST` become the task definition's
`Image`; there is no image parameter). The relay's INSTALL creates the stack
from the bootstrap stack's `ApplicationTemplateUrl` and can only set
`param_ContainerPort` and `param_HealthCheckPath` from the manifest
(`packages/relay/src/install.ts`, `buildInstallParametersFromManifest`). The
application's own release is only deployed after INSTALL succeeds
(auto-deploy of the newest READY release). So the first task of every
install runs whatever image the template was published with — in
production today `deployz-images@sha256:a61054b3…`, a Documenso build, with
the Documenso preset's env names and a container health command that
probes `localhost:3000/api/health` regardless of the parameters.

**Effect.** For any application whose port or health path differ from the
published image's, the ECS service never reaches a steady state, the
deployment circuit breaker fires, CloudFormation rolls the stack back
(~20 minutes), the INSTALL job fails, and the release that would have
worked is never deployed. The product's claimed MVP (any single-container
app inside the boundary) is, at the install step, a Documenso-shaped
install.

**Evidence.** Deployed API Lambda `BOOTSTRAP_TEMPLATE_URL` →
`bootstrap/v1/bootstrap-template-v1.json`; its `ApplicationTemplateUrl`
default → `application/v1/application-template-v1.json` (47 resources,
21 `NEXT_PRIVATE` occurrences, image digest `a61054b3d61aaa84…`, parameters
`paramContainerPort, paramHealthCheckPath, paramAppApiKey,
paramAppSigningSecret, paramPublicUrl, paramNextauthSecret,
paramEncryptionKey, paramEncryptionSecondaryKey, paramSmtp*`). The version
canary (`scripts/version-canary/steps.ts`, `publishCanaryTemplate`) had to
publish a per-run template pinned to its own image to install at all.

**Generic fix (Phase 3a).** The application template declares an image
parameter (default: the publish-time image, so existing templates and
Documenso installs are unchanged); the control plane's INSTALL payload
carries the newest READY release's image reference when one exists; the
relay passes it as a parameter (the undeclared-parameter drop keeps older
templates working); a regression test for each of the three. Not a
repository-specific change: it makes the install run the release the
product already selects for auto-deploy.

**Product decisions carried to the final report.** (a) Publish the generic
(no-preset) template as the production default and keep Documenso on a
preset only if it still needs one after binding aliases and generated
secrets. (b) Refuse an install launch when the application has no READY
release, instead of installing a placeholder image.

**Affected.** By construction every application other than the one the
production template was published for. Wave 1 records which repositories
would have hit it; after the fix the finding is measured by its absence.

**Fix.** `packages/cdk/src/application/application-stack.ts` declares
`param_ImageReference` (default: the publish-time image) and uses it
everywhere the task definitions reference the container image;
`packages/contracts/src/index.ts` exports its logical id as
`IMAGE_REFERENCE_PARAMETER`; `apps/api/src/install-parameters.ts`
(`buildInstallParameters`) sets it to the deployment's application's newest
READY release with a known image, omitting the key when there is none.

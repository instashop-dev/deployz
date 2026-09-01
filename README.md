# Deployz

Monorepo for the Deployz MVP. pnpm workspaces + Turborepo, TypeScript strict, Vitest, ESLint flat config.

## Layout

| Path | Package | Purpose |
| --- | --- | --- |
| `apps/web` | `@deployz/web` | Dashboard (Next.js arrives in a later todo; placeholder for now) |
| `apps/api` | `@deployz/api` | Fastify control-plane API (later todo) |
| `packages/contracts` | `@deployz/contracts` | Shared Zod contracts between api and web |
| `packages/db` | `@deployz/db` | Drizzle schema + migrations |
| `packages/cdk` | `@deployz/cdk` | Control-plane AWS CDK stack |
| `packages/analysis` | `@deployz/analysis` | Pure §18/§19/§20 repository analysis core (detectors, rejection checks, rules engine) — shared leaf dependency of `cdk` and `api` |
| `packages/fixture` | `@deployz/fixture` | Test fixtures / local dev harness |
| `packages/relay` | `@deployz/relay` | Relay Lambda (fixed-vocabulary customer-account actor) |
| `packages/copy-map` | `@deployz/copy-map` | Copy/message mapping helpers |

## Commands

Run from the repo root:

- `pnpm install` — install all workspace dependencies
- `pnpm vitest run` — run all tests (Vitest projects: `packages/*`, `apps/*`)
- `pnpm build` — build every package via Turborepo (`tsc` emit to `dist/`)
- `pnpm lint` — lint every package via Turborepo (ESLint flat config at root)
- `pnpm dev` — run every package's persistent dev script (`tsc --watch`)

End-to-end tests run against a simulated AWS account by default
(`pnpm e2e`) — no credentials required. See
[`docs/testing/README.md`](docs/testing/README.md) for the full test
hierarchy, including the real-AWS canary/fresh escalation modes.

## Deploying the control plane

**Deploys run in CI, not from a laptop.** `.github/workflows/deploy-api.yml`
deploys the stack — VPC, RDS, API Lambda, the SQS job queue with its worker, the
CodeBuild/ECR release pipeline, and the public template bucket — on every push to
`main` that touches the API, and on demand from the Actions tab. It supplies the
Lambda's entire environment from repository secrets.

`packages/cdk/bin/deployz.ts` refuses to run outside CI, because a hand-run
deploy rebuilds that environment from the developer's `.env`: `collectEnvVars()`
replaces the deployed environment rather than merging with it, so local values
overwrite production and every allowlisted key the `.env` lacks is *deleted* from
the running function — `API_DOMAIN_NAME` among them, which takes
`api.deployz.dev` offline.

To inspect the stack locally, opt in explicitly:

```bash
pnpm --filter @deployz/cdk exec cdk diff Deployz -c local=true
```

The CDK CLI passes the app no indication of which command invoked it, so that
flag necessarily re-enables `deploy` as well as `synth` and `diff`. It is there
for previewing changes, not for shipping them.

Publishing the customer bootstrap template is still a local step, because it
uploads an artifact rather than changing the stack:

1. `pnpm --filter @deployz/cdk run publish:bootstrap` — repacks the template to
   be self-contained, zips its Lambda assets, uploads both to the template
   bucket, and prints the URL.
2. Set that URL as the `BOOTSTRAP_TEMPLATE_URL` repository **variable**, then
   re-run the deploy workflow. Until it is set the API returns
   `quickCreateUrl: null` and the install page tells the customer no template has
   been published yet, rather than handing them a link CloudFormation cannot
   resolve.

One piece of configuration lives on GitHub rather than in this repo: the App's
**Setup URL** must be `<WEB_URL>/github/setup` with "Redirect on update"
enabled — that page binds the installation to the vendor's organization, by way
of `<API_URL>/api/github/setup`. It is on the web app rather than the API
because a vendor who installs the App while signed out has to be offered
sign-in, not handed an error.

## Module-resolution scheme

One base config (`tsconfig.base.json`, `strict: true` plus strict-adjacent flags), two per-package flavors:

- **NodeNext** (`module`/`moduleResolution: "NodeNext"`) for packages that run directly on Node: `apps/api`, `packages/cdk`, `packages/fixture`, `packages/relay`, `packages/analysis`. Relative imports in these packages must use explicit `.js` extensions.
- **Bundler** (`module: "ESNext"`, `moduleResolution: "Bundler"`) for libraries and the web app: `apps/web`, `packages/contracts`, `packages/db`, `packages/copy-map`. Extensionless relative imports allowed; if one of these is later consumed directly by Node (unbundled), switch it to NodeNext or add `.js` extensions.

Every package builds with `tsc -p tsconfig.json` emitting ESM + declarations to `dist/`. Tests (`src/**/*.test.ts`) are excluded from build emit; Vitest runs them from source.

## CI

`.github/workflows/ci.yml` runs on every push: `pnpm install --frozen-lockfile`, `pnpm vitest run`, `pnpm build`, `pnpm lint` on Node 24 with pnpm via `pnpm/action-setup`.

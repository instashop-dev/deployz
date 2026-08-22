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

## Module-resolution scheme

One base config (`tsconfig.base.json`, `strict: true` plus strict-adjacent flags), two per-package flavors:

- **NodeNext** (`module`/`moduleResolution: "NodeNext"`) for packages that run directly on Node: `apps/api`, `packages/cdk`, `packages/fixture`, `packages/relay`, `packages/analysis`. Relative imports in these packages must use explicit `.js` extensions.
- **Bundler** (`module: "ESNext"`, `moduleResolution: "Bundler"`) for libraries and the web app: `apps/web`, `packages/contracts`, `packages/db`, `packages/copy-map`. Extensionless relative imports allowed; if one of these is later consumed directly by Node (unbundled), switch it to NodeNext or add `.js` extensions.

Every package builds with `tsc -p tsconfig.json` emitting ESM + declarations to `dist/`. Tests (`src/**/*.test.ts`) are excluded from build emit; Vitest runs them from source.

## CI

`.github/workflows/ci.yml` runs on every push: `pnpm install --frozen-lockfile`, `pnpm vitest run`, `pnpm build`, `pnpm lint` on Node 24 with pnpm via `pnpm/action-setup`.

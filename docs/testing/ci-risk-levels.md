# Deployz CI risk levels

Every pull request to `main` is planned by `scripts/test-affected.mjs`
(the `Plan tests` job) and receives exactly one risk level. The level
decides what `Test and build` and `Simulated E2E` run.

| Level | Selected for | What runs |
| --- | --- | --- |
| `minimal` | Documentation-only or other non-executable text | Plan job plus selector self-tests; the heavy test, build, lint, and E2E steps skip |
| `targeted` | An isolated package, API, or test change | Affected package unit tests, affected lint, workspace build, and the targeted Playwright specs or scenario ids |
| `targeted-web` | A web runtime change | Web unit tests plus the full non-visual Playwright PR suite (reported as a full suite, never as targeted specs) |
| `critical` | A deployment-affecting change, or root configuration, lockfile, workspace, test-runner, workflow change, or any unknown executable path | The complete pre-merge validation: full unit suite, full simulated scenario suite, default-HTTPS suite, Team Admin flows, deployment-detail states |

Fail-safe: if change detection fails, the base reference is unavailable,
or a changed path is not mapped, the plan selects `critical`. A code
change can never select zero tests.

A push to `main` is never planned; it always runs the full regression.
The `PR Gate` job aggregates the planned jobs for pull requests and is
the only check intended to become a required status check later.

Run `pnpm test:affected` locally to see the same plan for your working
tree, or `pnpm test:affected --files=<csv> --format=json` for a specific
file list.

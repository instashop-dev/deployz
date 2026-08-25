# Block manual control-plane deploys

**Date:** 2026-08-25
**Status:** approved

## Problem

A `cdk deploy Deployz` run from a developer machine pushes that machine's local
`.env` into production.

`collectEnvVars()` (`packages/cdk/src/deployz-stack.ts`) copies an allowlist out
of `process.env`, which `bin/deployz.ts` has just filled from the repo-root
`.env` via dotenv. The result *replaces* the Lambda environment rather than
merging with it, so the damage runs in both directions: values present in `.env`
overwrite production, and values absent from `.env` are deleted from the running
function.

Measured against the `.env` on the maintainer's machine on 2026-08-25, a hand-run
deploy would have:

| Effect | Keys |
| --- | --- |
| Shipped localhost into production | `BETTER_AUTH_URL=http://localhost:3001` |
| Overwritten production secrets with dev ones | `BETTER_AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GITHUB_*` |
| Deleted from the running function | `API_URL`, `WEB_URL`, `MARKETING_URL`, `COOKIE_DOMAIN`, `EMAIL_FROM`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `STRIPE_PRICE_METERED` |
| Taken the API offline | `API_DOMAIN_NAME` / `API_CERTIFICATE_ARN` unset drops the `DomainName`, which is conditional on both |

The documented defence is a gitignored `.env.production` that `bin/deployz.ts`
loads over `.env`. That file does not exist on the maintainer's machine, so the
defence is documentation only.

Everything else is already sound and is not changed here: `.gitignore` covers
`.env*` with a `!.env.example` exception and only `.env.example` was ever
committed; `.dockerignore` excludes `.env*` and the web Dockerfile copies named
paths; the API Lambda is an esbuild JS bundle carrying no `.env`; and
`deploy-api.yml` supplies every allowlisted key from repository secrets on a
runner that has no `.env` at all. **CI is not the leak path — the hand-run
deploy is.**

## Approach

Refuse to run the control-plane CDK app outside CI. GitHub Actions becomes the
only route to production.

Rejected alternatives:

- **Validate the env and refuse when it looks local.** Catches the accident but
  leaves the hand-deploy path open, so it has to keep pace with every new
  allowlisted key. A gate that does not depend on the contents of `.env` cannot
  drift out of date with it.
- **Block at the AWS side** (bootstrap-role trust policy, stack policy, SCP).
  Real enforcement rather than a check, but the local AWS profile is the account
  root, which bypasses IAM entirely; a genuine wall needs an Organizations SCP
  and a move off root credentials. Out of scope, and it does not address the
  accident case any better than the gate does.

The gate is deliberately bypassable (`GITHUB_ACTIONS=true cdk deploy` defeats
it). The risk being addressed is habit and muscle memory — a person or an agent
running the command that the README, until now, told them to run. It is not a
determined operator.

## Design

### The rule

A pure decision function in a new `packages/cdk/src/deploy-gate.ts`:

```ts
checkDeployGate({ env, allowLocal }): { allowed: true } | { allowed: false; reason: string }
```

Allowed when `env.GITHUB_ACTIONS === 'true'`, or when `allowLocal` is set.
Refused otherwise.

The marker is `GITHUB_ACTIONS`, not `CI`. `CI=true` is set by a wide range of
local tooling and would quietly open the gate; `GITHUB_ACTIONS` is set only by a
GitHub runner.

Keeping the decision in a pure function, separate from the entrypoint, is what
makes it unit-testable without spawning the CDK CLI.

### Where it fires

In `packages/cdk/bin/deployz.ts`, after the dotenv loads and after `new App()`
(context is only readable through the App), and before
`new DeployzStack(app, 'Deployz')`. A refusal throws, so the CDK CLI exits
non-zero before writing `cdk.out` or contacting AWS.

### The refusal message

The message has to teach, because the person reading it was, until this change,
following the README:

```
Refusing to run the Deployz control-plane app outside CI.

Production deploys go through .github/workflows/deploy-api.yml — push to main,
or run it from the Actions tab. A deploy from a developer machine rebuilds the
Lambda environment from the local .env: it ships localhost origins and DELETES
every key the .env does not carry.

To synth or diff locally:  cdk diff -c local=true
```

### The `local` escape hatch

The CDK CLI passes the app no indication of which command invoked it — verified
against the installed CLI, which sets `CDK_OUTDIR`, `CDK_CONTEXT_JSON`,
`CDK_CLI_VERSION` and `CDK_DEFAULT_ACCOUNT`, but nothing naming the command. A
check inside the app therefore blocks `synth`, `diff` and `deploy` alike, or
none of them.

`-c local=true` keeps `synth` and `diff` usable, at the cost of also letting a
deliberate `deploy` through. That trade is accepted: previewing a production
change with `cdk diff` before merging is worth keeping, and a flag typed on
purpose and left in shell history is not the failure mode being defended
against.

### `BOOTSTRAP_TEMPLATE_URL`

`README.md` step 3 configures the bootstrap template URL by redeploying with
`BOOTSTRAP_TEMPLATE_URL` set, and `deploy-api.yml` does not set it. Making
deploys CI-only would leave no route to configure it at all, so the workflow
gains `BOOTSTRAP_TEMPLATE_URL: ${{ vars.BOOTSTRAP_TEMPLATE_URL }}` and the README
section is rewritten around the CI flow.

Noted but **not** fixed here: because CI has never set that variable, production
has it unset today, so the install page hands customers `quickCreateUrl: null`.
That is a pre-existing bug with its own fix.

## Out of scope

- Validating the *shape* of production values (localhost hosts, `replace_me`
  placeholders). The gate makes it unnecessary for the hand-deploy path; the
  workflow's existing verify step covers CI.
- The `STRIPE_PRICE_DEPLOYMENT` / `STRIPE_PRICE_METERED` naming drift between
  the local `.env` and the allowlist.
- The stale GitHub App Setup URL comment in `.env.example`.
- Setting `BOOTSTRAP_TEMPLATE_URL` to a real published template.

## Testing

`packages/cdk/test/deploy-gate.test.ts`, written before the implementation:

1. refuses on an empty environment
2. refuses on `CI=true` with no `GITHUB_ACTIONS` — the near-miss that matters
3. allows on `GITHUB_ACTIONS=true`
4. allows on `allowLocal` outside CI
5. the refusal text names both the workflow and the `-c local=true` flag

The existing CDK suite is unaffected: it constructs `DeployzStack` directly and
never loads `bin/`.

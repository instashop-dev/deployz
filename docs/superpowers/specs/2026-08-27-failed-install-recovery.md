# Failed first-install recovery — design decisions

Date: 2026-08-27
Branch: `failed-install-recovery`

## Problem

The relay INSTALL executor creates the application CloudFormation stack in
the customer's account. Production testing exposed a path where a failed
FIRST install permanently bricks the deployment:

1. `installApplicationStack` (relay `install.ts`) honestly reports terminal
   stack failures (`ROLLBACK_COMPLETE`, …) and does not recreate them —
   correct, and unchanged by this work.
2. CloudFormation cannot update a `ROLLBACK_COMPLETE` stack, so every
   future INSTALL fails while it exists.
3. Manual stack deletion can also fail: the application stack's RDS
   instance uses `RemovalPolicy.RETAIN` **and** `deletionProtection: true`,
   and the S3 bucket uses `RETAIN`. The retained RDS instance keeps its
   security group's ENIs alive, the security group keeps the VPC alive —
   the stack reaches `DELETE_FAILED` and the account needs manual AWS
   cleanup before the deployment can ever install.
4. There was no retry path at all: `apps/api` creates the INSTALL job only
   during relay registration, when `deployment.state === 'NOT_INSTALLED'`.

## The flow (as implemented)

```
vendor: POST /api/deployments/:id/retry-install
  │  guards (below) pass
  ├─ new INSTALL job, key `${deploymentId}:INSTALL:RETRY:${attempt}`
  │  payload { recovery: { neverInstalled: true } }
  ├─ deployment.state → INSTALLING, event install.retry.requested
  └─ relay picks the job up on its next 5-minute poll
       ├─ runRequestedRecovery     (payload flag set → recoverFailedInstallStack)
       │    refuse live/in-progress stacks
       │    delete terminal-failed stack → wait (bounded)
       │    if DELETE_FAILED: clear retained blockers
       │      RDS: disable deletion protection → delete instance
       │      ElastiCache: delete cluster
       │    re-delete stack → wait (bounded)
       ├─ installApplicationStack  (unchanged: honest create/adopt + watch)
       │    a stack still building DEFERS (pending store) and the resumer
       │    finishes it on later polls — recovery does not re-run on resume
       └─ verifyInstallation       (existing gate, unchanged)
```

## Decisions

### 1. Recovery runs inside the explicit retry — one vendor action

The retry button IS the recovery. A separate "clean up first" action would
add surface (a second button, a second state) for no safety gain: the
destructive step is already double-guarded (control-plane flag +
relay-side refusal of non-terminal-failed stacks). Auto-recovery without an
explicit action was rejected: silently deleting CloudFormation resources in
a customer account should always begin with a human decision.

### 2. "Never successfully installed" is asserted by the control plane

Only the control plane knows install history. The retry route refuses
(409 `INSTALL_ALREADY_SUCCEEDED`) when ANY prior INSTALL job ever reached
`SUCCEEDED`/`SUCCESS`. A deployment that was healthy once and failed later
keeps its data-protection guarantees — its failure belongs to
deploy/rollback, not to first-install recovery.

Defense in depth on the relay: `recoverFailedInstallStack` refuses to touch
any stack in a healthy (`CREATE_COMPLETE`/`UPDATE_COMPLETE`) or in-progress
state, whatever the payload claims, and identifies orphans only from the
failed stack's own resource list — never by name guessing. The Application
Stack's `RETAIN`/`deletionProtection` configuration is untouched: normal
retention guarantees are not weakened anywhere.

### 3. Recovery uses only already-granted IAM

The relay's phase-2 provisioner policy already grants
`rds:ModifyDBInstance`/`rds:DeleteDBInstance` and
`elasticache:DeleteCacheCluster`, all conditioned on the
`deployz:installation` resource tag — and the ApplicationStack tags its RDS
instance and cache cluster with it. Recovery needed ZERO new permissions;
the bootstrap template does not change.

### 4. The retained S3 bucket is deliberately left in place

It blocks nothing (it is not a VPC resource), costs nothing when empty (a
failed first install never ran the application), and emptying/deleting it
would require object-level `s3:DeleteObject*` grants the relay does not
carry — object ARNs do not resolve `aws:ResourceTag` conditions, so the
grant could not stay inside the tag boundary. A fresh install creates a new
bucket; the orphan is inert. Revisit only if orphaned buckets accumulate
measurably.

### 5. Bounded, convergent passes instead of unbounded waits

The relay Lambda runs 5 minutes. Every recovery wait is capped (~2 minutes
of polling by default) and sits INSIDE the INSTALL executor's own budget
discipline: when the budget runs out, recovery reports the real status
(`DELETE_IN_PROGRESS`) and the install step then reports honestly — the
vendor clicks retry again and each pass continues from real state. Recovery
is idempotent and each pass makes forward progress. Nothing is destructive
twice: a stack already deleting is waited on, not re-deleted (until it
settles `DELETE_FAILED`).

### 6. Retryable states

- `FAILED` — the relay honestly reported a failed install.
- `INSTALLING` with an in-flight job older than 30 minutes
  (`INSTALL_JOB_STALE_AFTER_MS` = 6 missed poll cycles) — a dead relay
  invocation (crashed Lambda, expired container) that would otherwise brick
  the deployment in `INSTALLING` forever. The stale job is superseded
  (`CANCELLED`) and a fresh retry is queued. (A deferred install whose relay
  is still alive does not hit this: the resumer reports within a poll or
  two, and the executor's install step — not the 30-minute route guard —
  is what answers it.)

Not retryable: `NOT_INSTALLED` (register path owns it), `INSTALLING` with
a fresh attempt (idempotent replay: a double-click on a live retry returns
the same job with 200), `HEALTHY`/`UPDATE_AVAILABLE`/`UPDATING` (nothing to
recover), `DELETING`/`DELETED`.

### 7. Attempt-scoped idempotency keys

The original job's key (`${deploymentId}:INSTALL`) is spent — a failed row
would be returned forever by `createOrReuseJob`. Retries use
`${deploymentId}:INSTALL:RETRY:${installJobCount}`, so each attempt gets a
fresh key while double-clicks on the same attempt still dedupe (the
in-flight replay check returns the live retry job before any key is
computed).

### 8. Honest status reporting is preserved

`installApplicationStack` never recreates a terminal-failed stack and
always returns the real CloudFormation outcome, including the `in-progress`
deferral path. Recovery is a separate module (`recover.ts`) that the retry
path runs BEFORE it. The verification gate after install is unchanged.

## Known limits (deliberate, MVP)

- A stuck `INSTALLING` deployment whose relay never returns (e.g. relay
  unenrolled) needs the existing relay reconnect path before retry works
  (409 `RELAY_NOT_CONNECTED` says so).
- The web dashboard has no retry button yet; the API route is the vendor
  surface. A UI action can call it unchanged.
- If a retried install defers (stack still building), the resumer reports
  the final outcome without re-running recovery — correct, since recovery
  already ran and the stack is now progressing.

## Testing

- `packages/relay/src/recover.test.ts` — recovery phases (clean delete,
  blocker clearing with protection-disable + re-delete, refusal of
  live/in-progress stacks, DELETE_STUCK, DELETE_IN_PROGRESS budget
  exhaustion, missing-client skip, no-stack no-op).
- `packages/relay/src/index.test.ts` — the executor arc: ROLLBACK_COMPLETE
  + retained DB → recovery clears blockers → stack recreated → verified →
  `success: true` (failure → cleanup → retry → healthy), plus honest
  no-recovery failure, live-stack refusal fall-through, stuck-report
  pass-through, and no-seam skip.
- `apps/api/src/server.test.ts` — the retry route: 202 + job payload +
  state + event from FAILED; idempotent double-click; 409 guards for
  ever-succeeded / not-retryable / relay-not-connected / fresh in-flight;
  stale-RUNNING supersession with cancellation.

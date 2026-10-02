# Pending-command authority and safe recreation (2026-10-02)

**Status:** active. Implemented in `packages/relay/src/install.ts` (three
create modes; the absent-vs-unreadable read distinction),
`packages/relay/src/pending.ts` (`compareAndSet`),
`packages/relay/src/poll.ts` (`onResultReported`) and
`packages/relay/src/index.ts` (the authority probe; the settled marker),
plus the `GET /api/relay/commands/:id/authority` route in
`apps/api/src/server.ts`. The lifecycle rules around it are in
[`../deployment-resilience.md`](../deployment-resilience.md).

## The problem

A pending INSTALL marker could recreate a stack during a DESTROY:

1. The relay defers an INSTALL (the stack outlives the invocation) and
   records the pending marker.
2. The stack rolls back and the INSTALL fails. The vendor disconnects, and
   DESTROY deletes the stack.
3. The relay's next poll — or a cold start — resumes the pending INSTALL.
   The stack is gone, so the resume used to create a fresh one,
   resurrecting infrastructure the vendor had just torn down.

## The decisions

1. **A pending INSTALL carries command authority.** Before it resumes or
   provisions, the relay asks the control plane
   `GET /api/relay/commands/:id/authority` (authenticated with the relay
   bearer token; returns `{active, jobState, reason?}`). Authority is false
   when the job settled or was cancelled, when the deployment is
   DELETING/DELETED, or when a later DESTROY superseded an INSTALL. A
   network or 5xx answer is ambiguous and defers all mutations.
2. **`installApplicationStack` has three create modes.** `fresh` (a first
   install creates when the stack is absent), `resume` (a resumed install
   adopts an existing stack and never recreates a missing one), and
   `recovery` (the authorized first-install recovery may recreate after
   `DELETE_IN_PROGRESS` becomes absent). Recovery rechecks authorization
   immediately before every `CreateStack`.
3. **A read distinguishes a confirmed absent stack from a failed read.** A
   throttle, a permission denial or a transport error (`absent: false` plus
   an `errorCode`) is never evidence that the stack was deleted. A run of
   unreadable reads fails with that distinction instead of claiming the
   stack was deleted.
4. **The settled marker is written before the result report.** On terminal
   settle the INSTALL resumer writes a `settled` marker (result +
   `settledAt`) instead of clearing first; the marker is cleared only after
   the result report succeeds (`onResultReported`). A failed report retries
   without rerunning provisioning. All clears and writes use
   `compareAndSet`, so a newer command's marker is never cleared or
   overwritten.
5. **DESTROY cancels an obsolete INSTALL.** A DISCONNECTED relay's active
   INSTALL is obsolete and is cancelled before the idle check, so it cannot
   block teardown. A CONNECTED relay's in-flight INSTALL still blocks
   DESTROY through operation exclusivity.

## The flow

```
relay poll:
  executor (first pickup):
    settled marker for this command? → re-report the stored result
    GET /api/relay/commands/:id/authority
      false → fail "no longer active"; provision nothing
      null  → write the pending marker; defer
      true  → settleInstall (createMode fresh/recovery)
  resumer (later polls, cold start):
    settled marker? → retry the stored result report; never provision again
    GET /api/relay/commands/:id/authority
      false → clear the marker (compareAndSet); provision nothing
      null  → keep the marker; defer to the next poll
      true  → settleInstall (createMode resume/recovery)
  terminal settle → write the `settled` marker (compareAndSet)
  report the result → on success, clear the marker (compareAndSet)
```

## AWS qualification: DEFERRED

This change is qualified by unit/contract tests and the simulated
`stale-install-resurrect` scenario only. Real-AWS `fresh`/`profile`/`core`
qualification is deferred and NOT run for this change. This is not a
release-readiness claim.

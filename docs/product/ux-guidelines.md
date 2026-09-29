# Deployz UX guidelines

The target Deployz experience. The charter
([`ux-excellence-charter.md`](ux-excellence-charter.md)) defines how the UX
program works. This document defines what the UX must be. The code and the
product documents stay authoritative for current behavior; the UI mechanics
(shadcn, tokens, typography) stay in [`../ui-system.md`](../ui-system.md).

Each decision has a status:

- **PROPOSED — PENDING HUMAN REVIEW**: a UX-A decision. Do not implement it
  until a human accepts it.
- **ACCEPTED**: approved. Implement it in the phase that owns it.

All decisions below are **STATUS: PROPOSED — PENDING HUMAN REVIEW** unless
a section says otherwise.

## 0. Evidence base (UX-A, 2026-09-29)

- Source audit of `apps/web` against the charter questions (vendor journey,
  customer journey, UI inventory), with the important findings verified
  again in code.
- Browser capture of the running application: a local simulated stack
  (real API, real web app, simulated AWS relay) in four scenarios —
  happy path, waiting for AWS, health-check failure, slow provisioning —
  plus a fresh application and an application that needs input. The
  screenshots are session evidence only; they are not committed (the docs
  index forbids run reports).

Verified current problems (evidence in brackets):

| # | Problem | Evidence |
| --- | --- | --- |
| E1 | A failed deployment tells three different stories. Header: "Installing" + "Unhealthy". Hero: "Your application is not responding". Infrastructure: "Services are being created" with every service Ready. Diagnostics: "The application service was not created". Home: "Installing — Setting up this deployment". | Health-check-failure capture; `lib/home-state.ts:238` ignores health |
| E2 | On a failed deployment the primary button is "Open application". Disabled "Deploy update" and "Configuration" have the same weight as the enabled "View diagnostics". | Deployment detail, failure capture |
| E3 | Diagnostics "Next step" sends the vendor back to the deployment page, which sent the vendor to Diagnostics. | Diagnostics, failure capture |
| E4 | The architecture list shows three times: Overview "Architecture detected", Configuration "Application architecture", and again as rows of "Planned infrastructure". | `architecture-detected-card.tsx`, `application-architecture-section.tsx`, Configuration capture |
| E5 | Configuration is one long page with six sections, three tables and AWS sizing (Fargate, db.t4g.micro, NAT gateway) at the top level. "Re-analyse" hides inside "Deployment preferences". An empty "Customer overrides" block tells the vendor to go elsewhere. | Configuration capture |
| E6 | The header shows "No release yet" next to a primary "Start test deployment". The release is built implicitly; the lifecycle (Analyse → Configure → Test → Share) never names it. | Fresh-application capture, `lib/application-state.ts:746` |
| E7 | The customer page, after a disconnect, says "One item remains: the Deployz connector stack". The retained database and bucket also remain and keep costing money unless the vendor purged them. The removed branch ignores the plan and the status `cleanup` field, which together can tell. | `app/install/[installLinkId]/page.tsx:191-225` |
| E8 | The customer waiting page has two AWS buttons ("Open AWS setup", "Open AWS CloudFormation"), a raw stack name, an installation reference, and empty "Live AWS activity" and "Resources" sections. The first step reads "AWS account connected" while it is still in progress. | Waiting-for-AWS capture |
| E9 | The customer security facts are reachable only after confirm. The confirm form, where the customer types secrets, has no link to them. | `components/public-install-flow.tsx` |
| E10 | "Your application secrets" is listed as data never sent to Deployz, but customer secrets pass through the KMS-encrypted pending-secret vault. | `lib/security-details.ts:178`, `docs/pending-secret-delivery.md` |
| E11 | `/dashboard/onboarding` (six steps) has no link from any page. Home has a separate three-step card; the application page has a four-step lifecycle. | grep of `apps/web/src` |
| E12 | One concept, many words: Relay / connector; Disconnect / Remove / Purge; "Create installation" (creates an invitation); "Private install link" / "Unlisted deployment link"; "Technical details" / "Advanced details" / "Analysis details" / "Show technical…". | grep counts in the UX-A audit |
| E13 | The vendor deployment page in "Waiting for AWS" lists all 11 passed preflight checks. | Waiting-for-AWS capture |

Checked and not a current problem: raw CloudFormation status in primary
UI (guarded by ESLint and E2E jargon checks); application-page state
derivation (single source in `lib/application-state.ts`); commit picker
quality; pre-install cost, resources, retention and access copy on the
customer page; status vocabularies (centralized in `@deployz/copy-map` with
a parity test).

## 1. Vendor journey (target)

One line per step: where, dominant action, what the vendor must know.

| Step | Where | Dominant action | Rule |
| --- | --- | --- | --- |
| 1 Connect repository | Home (first use) → Add application | "Add application" | Analysis starts on select. No separate onboarding route. |
| 2 Deployz understands the app | Application › Overview | none (progress) | Show what is being analysed and when it ends. |
| 3 Fix anything required | Overview card → Configuration › Required changes | "Review required changes" | One list of what blocks deploy, each with one fix action. |
| 4 Test | Overview card | "Start test deployment" | The card says it builds release vX from `branch@sha` and deploys it to the vendor's AWS account. |
| 5 Share | Overview card | "Copy install link" | The link lives on Overview only. "Invite customer" is the targeted variant. |
| 6 Release updates | Application › Releases | "Create release" | Creating a release never updates a customer. Rollout is per deployment. |
| 7 Monitor | Home, Deployments | the row that needs attention | Home shows only what needs action, then a fleet count. |
| 8 Act on a deployment | Deployment detail | one per state (§5) | All deployment operations live here. |

Remove the separate onboarding route (E11). Home's first-use card and the
application lifecycle are the only setup guidance.

## 2. Customer journey (target)

The customer answers seven questions before they deploy. Each has one
home on the review page, in this order:

1. **What am I installing, from whom?** Application, publisher, release.
2. **Where?** Region (selected or recommended) and "the AWS account you are
   signed in to".
3. **What will be created?** Resources grouped under generic headings.
4. **Approximate cost?** The Region-priced monthly range.
5. **What access does Deployz get?** Three facts plus "Security details"
   (link, available on the confirm form too — E9).
6. **What do I provide?** Only the "Set by customer" settings; secrets in
   `SecretInput`.
7. **What remains after removal?** The retained items and their cost.

Then:

| Stage | Customer sees | Dominant action |
| --- | --- | --- |
| Review and confirm | The seven answers, one form | "Continue to setup" |
| Launch | "You will approve one setup stack in AWS" | "Review setup in AWS" |
| Waiting for AWS | One step in progress: "Connecting your AWS account". One fallback action after the staleness window: "Retry connection". Stack name and reference under Technical details (E8). | none, then "Retry connection" |
| Deploying | Completed steps, the current step with elapsed and typical time, what comes next | none |
| Ready | The HTTPS address and "Open application" | "Open application" |
| Failed | What happened, that no action is needed from the customer (or what is), whom to contact | "Contact {publisher}" copy, no button |
| Removed | What was removed, what remains, what it costs, how to delete it (E7) | "Open AWS console" to delete what remains |

Customer copy never says Relay, IAM, ECS, RDS, ALB, VPC or Lambda at the top
level. "AWS", "CloudFormation" (only at the launch and delete steps) and
"Deployz connector" are allowed.

## 3. Information architecture

Sidebar (unchanged): Home, Deployments, Applications, Customers;
Management: Team, Billing, Settings.

Ownership of objects — each action has one home:

| Object | Owns | Does not own |
| --- | --- | --- |
| Application | Analysis, configuration, releases, the install link | Deployment operations |
| Customer | Contact details, invitations, the list of that customer's deployments (links) | Deployment operations, install link |
| Deployment | Status, every day-2 action, per-deployment configuration, failure explanation, infrastructure detail | Application defaults |

Changes:

- **Diagnostics folds into Deployment detail.** The failure panel in the
  hero carries what happened / impact / action (§9). The infrastructure
  check table moves under Technical details on the same page. Keep the
  `/diagnostics` route as a deep link that scrolls to that section (E1, E3).
- **Customer detail** keeps one "Invite customer" button in the header.
  Remove the duplicate empty-state buttons.
- **Customer overrides** of environment values are edited only on the
  deployment's Configuration. Remove the empty override block from the
  application's Configuration (E5).

## 4. Application page hierarchy

Tabs: **Overview · Configuration · Releases** (Configuration moves before
Releases to match the flow).

Header: name, one status badge (§7), repository. Remove the second
release badge; the release state shows in the Overview card and on
Releases (E6). An overflow menu holds "Re-analyse application" — its one
permanent home.

**Overview** — at most three blocks:

1. The state card (unchanged source: `deriveApplicationPresentation`).
2. The install link row, only when a live link exists.
3. One line: "N services detected · View" → Configuration › Services.
   Remove the full "Architecture detected" list (E4).

**Configuration** — sections in this order, with in-page anchors:

1. **Required changes** — only when present.
2. **Environment variables** — one table. Value entry inline per row.
   Filter chips stay. The detection reason ("Suggested", "Uncertain")
   moves into the row's detail.
3. **Services** — merges Application architecture + Data & infrastructure
   + Planned infrastructure: one row per component with state (Detected /
   Confirmed / Needs input), what customers get, and "Kept" / "Removed" on
   removal. AWS sizing (Fargate, instance class, NAT gateway, resource
   count) under Technical details.
4. **Build & runtime** — port, health path, migration command, start and
   build command. "Not detected" rows say what to do.
5. **Settings** — name, repository, branch, danger zone.

**Releases** — list plus "Create release". The form: commit (picker),
version, optional migration override. A failed row opens failure details
(unchanged).

## 5. Primary action per state

One filled button per screen. Other actions are outline, or in "More
actions". Do not show disabled actions that the state cannot use; say in
one line when they become available.

| Surface / state | Primary action |
| --- | --- |
| Application · analysing | none |
| Application · analysis failed | Retry analysis |
| Application · needs input | Review required changes |
| Application · ready to test | Start test deployment |
| Application · test running | View test deployment |
| Application · test failed | Review failure |
| Application · ready to share / live | Copy install link |
| Release · build failed | Review failure details |
| Deployment · waiting for customer | Copy install link |
| Deployment · setting up | none |
| Deployment · live | Open application |
| Deployment · needs attention (unhealthy, failed install, lost contact) | Review failure (opens the failure panel) |
| Deployment · update failed | Retry update |
| Deployment · update available | Deploy update |
| Deployment · removed with retained data | Delete retained data (outline, destructive) |
| Customer page · review | Continue to setup |
| Customer page · launch | Review setup in AWS |
| Customer page · ready | Open application |

## 6. Canonical terminology

| Use | Do not use | Note |
| --- | --- | --- |
| Application | app, product | "app" is allowed in URLs and "Open application" is the button. |
| Analysis, Analyse, Re-analyse | Analyze, Reanalyse | British spelling, already dominant. |
| Release | build, image, version (as noun) | "Version" is the release's label; "build" is the process. |
| Deployment | installation, environment | "Install" is the verb for the first deployment only. |
| Test deployment | test install | |
| Install link | deploy link, installation link, private/unlisted link | The reusable per-application link. |
| Invitation · Invite customer | Create installation, pending installation | The one-customer link. |
| Deployz connector | Relay, bootstrap | "Relay" is internal. |
| Remove deployment | Disconnect, uninstall | Keeps retained data. |
| Delete retained data | Purge | Permanent. |
| Needs attention | issue, problem, error (as a status) | |
| Technical details | Advanced details, Analysis details, Show technical… | One label for every disclosure of raw data. |
| Sentence case for buttons | "Create Release" | |

## 7. Canonical status model

One status per object, derived once, shown with the same words on every
surface (Home, lists, detail, customer page). A second badge is allowed
only for a different dimension that the user acts on.

**Deployment (vendor)** — one primary status:

| Status | Meaning (from existing data) |
| --- | --- |
| Waiting for customer | Created, customer has not launched |
| Setting up | Install in progress, not yet failing |
| Live | Healthy and verified |
| Needs attention · {reason} | Unhealthy, degraded, failed install, lost contact, removal failed |
| Updating | Day-2 operation in progress |
| Update failed | Previous release still live |
| Removing | Removal in progress |
| Removed | Terminal; "retained data" note while it exists |

Health overrides the operation label: an install with failing health checks
is **Needs attention · Not responding**, not "Installing" (E1). Home, the
lists and the detail use `lib/deployment-status-groups` as the one
classifier; `home-state.ts` must not classify state itself.

**Customer page** — Setting up · Ready · Needs attention · Removed.

**Application** — Analysing · Needs input · Analysis failed · Ready to test
· Testing · Test failed · Ready to share · Live. "Changes required" and
"Needs review" merge into **Needs input**; the card says which.

**Release** — Building · Ready · Build failed · Unavailable.

## 8. Progressive disclosure

Top level shows product language: what, state, next action. Behind
"Technical details" (collapsed, one label):

- AWS resource types, logical IDs, stack names, stack status, ARNs,
  account IDs, installation references, raw events, raw error text.
- Sizing: vCPU, memory, instance class, storage size, NAT gateway.
- Detection evidence (file, reason, confidence words).
- Passed checks. Show only failed or pending checks at the top level;
  "All N checks passed" is one line (E13).
- The default load-balancer hostname when an HTTPS address exists.

Never hide: cost, retained resources, access granted, data that leaves the
customer's account, a failure summary, the rollback migration warning.

## 9. Error and recovery model

Every recoverable failure renders one panel, top to bottom:

1. **What happened** — one sentence, product words.
2. **Impact** — what still works ("Release v3 is still live").
3. **Who acts** — vendor repository, vendor configuration, customer, Deployz,
   or temporary.
4. **Recovery action** — one primary button (§5).
5. **Technical details** — collapsed.

Rules:

- One source per failure. The deployment page, Home and the customer page
  show the same classified summary. The infrastructure check never
  contradicts it; while an operation runs, an infrastructure check result
  that predates it is labelled "from the previous check" or hidden (see
  UX-BACKEND-002).
- No circular next steps (E3).
- Customer failures say whether the customer must do anything. Usually
  they must not; name the publisher to contact.
- Analysis and build failures offer: Retry, "Copy prompt for coding agent",
  and "Copy report for Deployz support" when Deployz must act.
- Inline `Alert` for failures; toast only for short success.

## 10. Long-operation and progress model

One step-list pattern for install, update and removal, on both surfaces:

- Completed steps (collapsed after completion into "N steps done").
- The current step: present-tense label ("Connecting your AWS account"),
  elapsed time, typical duration, "Checked just now".
- The next step name.
- A single line when user action is required, with the action.
- "Taking longer than usual" guidance only past the typical duration.

Step labels are present tense while running and past tense when done
("Connecting…" → "Connected"). Never label a running step with its done
text (E8). The live activity feed and the component list show only after
the first infrastructure event; before that they do not render.

## 11. Minimum shared primitives

Build only these; everything else is direct shadcn composition.

| Primitive | Replaces | Why |
| --- | --- | --- |
| `StepList` | `deployment-progress-steps`, `deployment-stepper`, `live-step-detail` | Same shape on vendor and customer surfaces (§10). |
| `StatusBadge` over `deployment-status-groups` | `DeploymentStatusBadge`, header double badges, Home's own labels | One status per object (§7). |
| `FailurePanel` | hero failure block, diagnostic card, customer `FailureDetails`, release failure summary | One recovery model (§9). |
| `TechnicalDetails` | four differently named `Collapsible` disclosures | One label, one behavior (§8). |
| `SecretInput` (exists) | the inline password field in `public-install-flow.tsx` | Reuse. |
| `EmptyState` over shadcn `Empty` | hand-written "No … yet" blocks | Only when a surface is touched anyway. |

Do not build: `PageHeader`, generic data tables, card factories.

## 12. UX-BACKEND items

Recorded, not implemented. Each needs separate approval.

### UX-BACKEND-001 — Force-completed removal is invisible to the customer

- **Problem**: After a disconnect, the customer page says only the connector
  stack remains (E7). The common case is a frontend fix: the lookup carries
  the frozen plan (retained components) and the status payload reports
  `cleanup: 'COMPLETE'` after a purge (`customer-activity.ts:470`). The
  remaining gap: when the vendor force-completes a removal because the
  connector is gone (`cleanupState: SKIPPED_RELAY_OFFLINE`), or a purge
  fails (`PURGE_FAILED`), the customer payload reports `cleanup: null`,
  the same as an ordinary disconnect.
- **User impact**: After a force-complete, the application, network and
  cache may also still run in the customer's account. The customer is told
  only about retained data and keeps paying for the rest.
- **Evidence**: `packages/contracts/src/index.ts:650` (customer `cleanup`
  enum has no "not verified" value); `apps/api/src/customer-activity.ts:463-472`;
  `docs/deployment-resilience.md` (`DELETED` with `SKIPPED_RELAY_OFFLINE`).
- **Why frontend cannot solve it**: `cleanupState` is not in the customer
  payload; the page cannot tell a verified removal from an unverified one.
- **Required capability**: The customer status says when removal of AWS
  resources was not verified.
- **Minimal change**: Add `'UNVERIFIED'` to the customer `cleanup` enum,
  set from `SKIPPED_RELAY_OFFLINE` and `PURGE_FAILED`.
- **Priority**: P2 (the P1 part — E7 — is UX-B frontend work).

### UX-BACKEND-002 — Infrastructure check freshness against the current operation

- **Problem**: Diagnostics shows "The application service was not created"
  while the same deployment's events say the application started (E1).
- **User impact**: The vendor gets contradictory diagnoses and does not
  know what to fix.
- **Evidence**: Health-check-failure capture; diagnostics page reads the
  latest infrastructure check with no link to the job it evaluated.
- **Why frontend cannot solve it**: The client cannot know whether a check
  predates the running or latest operation.
- **Required capability**: Each check result carries the job or time window it
  describes.
- **Minimal change**: Return `checkedAt` and `jobId` of the operation in
  force when the check ran; the page labels stale checks.
- **Priority**: P2. Verify on real AWS first; the simulated relay may
  compress timing.

### UX-BACKEND-003 — Component status lags the install stage

- **Problem**: The customer "Resources" list shows "Web service: Waiting"
  after "Health check" completed.
- **User impact**: Progress looks stuck or wrong.
- **Evidence**: Slow-provision and health-check-failure captures;
  `specComponents` derive from stack events only.
- **Why frontend cannot solve it**: Inferring component state from the
  stage would invent backend truth.
- **Required capability**: Component status reflects service health once the
  stage passes it.
- **Minimal change**: Mark the runtime component ready when the job reports
  the service started.
- **Priority**: P3. Confirm on real AWS before work; possibly a simulation
  artifact.

## 13. Open decisions for human review

1. **Test deployment as a gate.** The UI hides the install link until a test
   passes; the API does not enforce it. Keep the gate, make it a
   recommendation, or enforce it in the API?
2. **Release step in the lifecycle.** Keep four steps with the release
   built inside "Test" (proposed), or show five steps with an explicit
   "Release"?
3. **Remove / Delete retained data** as the user-facing names for Disconnect
   / Purge. This changes customer-visible and vendor-visible copy and
   documents.
4. **Diagnostics as a section** of deployment detail (proposed) or a
   separate page that only shows evidence?
5. **Secret-handling copy (E10).** Confirm the exact truthful statement
   for customer secrets in transit with the owner of
   `docs/pending-secret-delivery.md`.

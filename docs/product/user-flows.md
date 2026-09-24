# Deployz user flows — vendor and customer journeys

What each actor does, in order, and who configures what. This describes the
product **as implemented** at the time of writing; where the implementation
falls short of the documented intent, the gap is stated rather than hidden.
Scope and non-goals are in [`mvp-scope.md`](mvp-scope.md); the machinery
behind each step is in [`../architecture.md`](../architecture.md).

## Actors

- **Vendor** — the software company. Signs in to the Deployz dashboard
  (`apps/web`), owns applications, releases, customers and deployments.
- **Customer** — the vendor's customer. Never needs a Deployz account. Uses a
  public install page and their own AWS console.
- **Deployz team** — operates the control plane and the Team Admin support
  console ([`../admin/team-admin.md`](../admin/team-admin.md)).

## Vendor journey

| # | Step | Where | What the vendor does or sees |
| --- | --- | --- | --- |
| 1 | Sign up, organisation | `/sign-up`, `/organizations/new`, `/dashboard/settings` | Email + password or GitHub OAuth. One organisation with owner / admin / member roles. The organisation name is the publisher name customers see. |
| 2 | Onboarding | `/dashboard/onboarding` | Six steps: connect GitHub → choose repository → analyse → fix compatibility → create a test deployment → ready for customer deployment. |
| 3 | Connect GitHub | `/github/setup` | Installs the Deployz GitHub App and selects repositories. The App's Setup URL must point at this page (see [`../operations/control-plane.md`](../operations/control-plane.md)). Webhooks handle installation events only; pushes do not trigger builds. |
| 4 | Create an application | `/dashboard/applications/new` | Picks a repository. Analysis starts automatically. One application per repository. The branch is the repository's default branch at creation and cannot be changed afterwards. |
| 5 | Analysis and readiness | `/dashboard/applications/[id]` | A state-aware overview (Analysing, Changes required, Needs review, Ready to share, Live with customers, …). The setup lifecycle is **Analyse → Configure → Test → Share**. "Copy prompt for coding agent" produces fix instructions for blocking findings. Re-analysis is on request only. See [`../ai-analysis.md`](../ai-analysis.md). |
| 6 | Configuration | `…/config` | Overrides for container port, health path, migration command, and the database / storage / Redis requirements. Application root, Dockerfile path, build context and build/start commands are settable through the API (`PATCH /api/applications/:id`) but have no UI. |
| 7 | Environment variables | same page | For each detected variable: build or runtime, required, secret, and who provides it (Managed by Deployz / Set by vendor / Set by customer / Optional), plus a customer-facing label and help text. Vendor values are stored KMS-encrypted. See [`../environment-variables.md`](../environment-variables.md). |
| 8 | Releases | `…/releases` | Picks a commit from the configured branch (or enters a full SHA), gives it a version, optionally overrides the migration command. CodeBuild builds the image into ECR by digest. States: Building, Ready, Build failed (with log evidence and an optional AI explanation), Unavailable (image deleted). Creating a release never updates a customer. |
| 9 | Test deployment | `/dashboard/deployments/new?…&test=true` | One free TEST deployment per application, into the vendor's own AWS account, through the same install page a customer uses. The UI offers the customer install link only after a successful test deployment (the API does not enforce this). |
| 10 | Share with customers | see *Customer entry points* below | Three ways to hand a customer an install: a reusable public install link, a targeted invitation, or a vendor-created deployment. |
| 11 | Fleet views | `/dashboard/deployments`, `/dashboard/customers` | Deployments grouped as Needs attention / In progress / Waiting for customer / Update available / Healthy / Removed. Customers roll up to Not installed / Installing / Live / Needs attention / Removing / Removed. |
| 12 | Deployment detail | `/dashboard/deployments/[id]` | A hero states the situation ("Waiting for your customer to install", "Your application is live", "Lost contact with this deployment"), the current release, the URL, health, and the relay connection. Raw AWS detail lives under "Advanced details". `…/diagnostics` explains a failure with evidence, a recoverability class and, when the deterministic classifier cannot resolve it, an AI explanation. |
| 13 | Day-2 actions | same page | Deploy update, Restart, Rollback to a previous release, Configuration (customer scope), Retry deployment (failed first install), relay reset, default-HTTPS retry. Actions are gated in this order: removed → never installed → relay not connected → another operation running. A failed update keeps the previous release live. Rollback never re-runs migrations. Bulk deploy of one release to every deployment exists only as an API route. |
| 14 | Custom domain | deployment detail → customer install page in a vendor session | The vendor enters the hostname; the customer creates two CNAME records in their own DNS; the relay issues an ACM certificate and wires the 443 listener. Change = remove, then add. See [`../networking-and-https.md`](../networking-and-https.md). |
| 15 | Disconnect and Purge | deployment detail | Disconnect (type-to-confirm, plan-driven) deletes the application, network and cache and **retains** the database, its credentials and the bucket. Purge deletes the retained items. Force-complete settles a disconnect whose relay is gone. Only the vendor can purge. |
| 16 | Billing | `/dashboard/settings/billing` | Paddle subscription. Evaluation is free; the first PRODUCTION deployment requires the $49/month platform subscription; each live production deployment adds $19/month. See [`../billing/paddle-billing.md`](../billing/paddle-billing.md). |

### Customer entry points (vendor side)

| Entry point | Created from | What it creates | Region | Status |
| --- | --- | --- | --- | --- |
| **Reusable public install link** | Application overview ("Create install link") | Nothing until a customer confirms. Each confirmation creates a new customer record and a PRODUCTION deployment. One live link per application; enable / disable / revoke / regenerate. | Customer selects (pre-selected to the vendor's recommendation, else the first offered Region) | Works end to end. |
| **Targeted invitation** | Customer detail page ("Create installation") | Nothing until the customer confirms. Bound to one customer, secured by a one-time token shown once. | Customer selects | **Does not work in the browser today**: the customer page never sends the token the API requires, so the link resolves as invalid. Tracked as a code gap; see [`../installation-invitations.md`](../installation-invitations.md). |
| **Vendor-created deployment** | "Create deployment" / "Create installation" on Home, Deployments, Customers list, Onboarding | A PRODUCTION (or TEST) deployment immediately, in NOT_INSTALLED, with a per-deployment install link (30-day TTL, revoke / rotate). | **Vendor** picks the Region | Works end to end. This is the primary CTA in the dashboard today. |
| Legacy deploy link | API only (`POST /api/customers/:id/deploy-links`) | A `/deploy/<publicId>?token=…` link with a vendor-fixed Region | Vendor | Legacy; kept for links that already exist. See [`../deploy-links.md`](../deploy-links.md). |

## Customer journey

1. **Receive a link** from the vendor (Deployz sends no email to customers).
   No Deployz account is needed.
2. **Review and choose** (public-link flow only, `apps/web/src/components/public-install-flow.tsx`):
   the AWS Region (only Regions the control plane can install into are
   offered), the application settings the vendor marked "Set by customer"
   (secrets in password fields, `_URL` / `_EMAIL` / `_PORT` names
   format-checked), name and email, the INSTALL plan, the AWS resources that
   will be created, a Region-priced monthly cost estimate, and the retention
   notice ("PostgreSQL and stored files are retained"). There is no
   infrastructure-size choice. "Continue to setup" confirms: the server
   re-checks the link, Region, preflight and the vendor's subscription, then
   creates exactly one deployment. Customer secrets go into the KMS-encrypted
   pending-secret vault ([`../pending-secret-delivery.md`](../pending-secret-delivery.md)).
   A vendor-created deployment skips this step; the vendor enters customer
   values on the deployment's configuration page instead.
3. **Pre-launch page** (`/install/<installLinkId>`): application, publisher,
   Region, release, cost estimate, "What Deployz will create", security facts,
   and a link to inspect the template and permissions
   (`/install/<id>/security`). "Review setup in AWS" marks the deployment
   WAITING_FOR_RELAY and opens the CloudFormation **Quick Create** URL for the
   frozen Region.
4. **Quick Create** in the customer's own AWS console creates the
   `deployz-bootstrap-…` stack: the relay Lambda on a 5-minute schedule, its
   IAM role with a permissions boundary, the CloudFormation execution role,
   and the relay credential in Secrets Manager.
5. **Relay enrollment**: the relay registers with a single-use enrollment
   code; preflight runs again; the INSTALL job is created. While waiting, the
   page shows "Still connecting" guidance, a retry that mints a new code, and
   a link to CloudFormation.
6. **Install progress**: the page polls `GET /api/install/:id/status` and
   shows the stages (Waiting for AWS → Connecting → Provisioning → Verifying →
   Ready) with plain-language sub-steps (running migrations, starting the
   application, checking health, setting up HTTPS). Raw CloudFormation events
   are in a collapsed disclosure. INSTALL success auto-deploys the newest
   READY release.
7. **Permanent HTTPS URL**: `https://d-<deployment-id>.deployz.dev`, with no
   DNS work by the customer. READY needs verified health plus a verified
   HTTPS endpoint. Traffic to this URL passes through Deployz's Cloudflare
   edge; a custom domain routes directly to the customer's load balancer.
8. **Custom domain** (optional, vendor-initiated): the customer page shows the
   two CNAME records to create and a "Check now" button. The customer cannot
   add or remove a domain.
9. **After a disconnect**: the page says the deployment was removed and asks
   the customer to delete the `deployz-bootstrap-…` stack in CloudFormation.
   Until the vendor purges, the retained database, its credential secrets and
   the S3 bucket also remain in the account and continue to cost money; the
   current page copy does not say so (tracked as a code gap).
10. **What the customer must delete themselves**: always the bootstrap
    (connector) stack. If the vendor never purges: the retained RDS instance,
    its secrets, the bucket, and the network objects the retained database
    pins (a private subnet, the database security group, the VPC).
11. **What the customer cannot do in Deployz**: no deploy, rollback, restart,
    configuration, disconnect or purge. The customer uninstalls only through
    the AWS console.

## Who configures what

| Item | Who | When | Notes |
| --- | --- | --- | --- |
| Repository, application | Vendor | Before analysis | One application per repository; branch fixed at creation. |
| Port, health path, migration command, DB/Redis/storage overrides | Vendor | Before install; later edits affect later installs and deploys | A requirement change on a live deployment is reported as drift, never applied; a new deployment is needed. |
| Build settings (app root, Dockerfile, build context, build/start command) | Vendor | Before a release | API only. |
| Environment-variable classification, labels, help text | Vendor | Before release / install | |
| Vendor build-time values | Vendor | Before a release | Missing values block release creation. Values are baked into the image. |
| Vendor runtime values and secrets | Vendor | Before install | Not pushed to existing deployments. |
| Customer runtime values ("Set by customer") | Customer on the public install page, or the vendor on the customer's behalf | Before confirm; day 2 through the vendor | |
| Deployz-generated secrets (`…SECRET`, `SECRET_KEY_BASE`, …) | Relay, inside the customer account | At install | Minted with `crypto.randomBytes`; never stored in the control plane. |
| Deployz-managed bindings (`DATABASE_*`, Redis, S3, `AWS_REGION`, `PORT`) | Deployz | At install | Injected by the application template. |
| Recommended Region | Vendor (optional) | On an invitation or public link | Shown as a badge and pre-selected. |
| Region | Customer (public link, invitation) or vendor (vendor-created deployment, legacy deploy link) | At creation | Immutable afterwards. |
| Infrastructure size | Nobody | At creation | `small-v1` is frozen on every deployment. |
| Deployment type | Vendor | At creation | TEST via the create page; every customer confirmation is PRODUCTION. |
| AWS account | Customer | At launch | Whichever account runs the Quick Create. |
| Custom domain hostname | Vendor | Day 2 | |
| Custom domain DNS records | Customer | Day 2 | In the customer's DNS provider. |
| Default HTTPS URL | Deployz | After install | Automatic. |
| Deploy, rollback, restart, config update, disconnect, purge | Vendor | Day 2 | |
| Bootstrap stack deletion | Customer | After disconnect | CloudFormation console. |
| Included production deployment allowance | Deployz team (Team Admin) | Any time | |

## Who chooses the AWS Region

The intended model is: the vendor **recommends**, the customer **selects**, and
the Region is **immutable** once the deployment exists. The current
implementation matches this for the public install link, except that the
page pre-selects the recommended Region (or the first offered Region) instead
of demanding an explicit choice. For a vendor-created deployment the vendor
chooses the Region before the customer sees anything. Region enablement is an
operator setting; see [`../operations/control-plane.md`](../operations/control-plane.md).

## Status vocabulary

The customer-facing and vendor-facing vocabulary is defined once in
`packages/copy-map` and `apps/web/src/lib/deployment-vocabulary.ts`; raw
CloudFormation and ECS states never appear in the primary UI (an ESLint rule
rejects raw CloudFormation status literals in `apps/web`). See
[`../ui-system.md`](../ui-system.md) for the page anatomy and status rules and
[`../deployment-resilience.md`](../deployment-resilience.md) for the
underlying deployment, job and health states.

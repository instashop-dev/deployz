/**
 * Canonical trust-story data for the Security Details page (§45).
 *
 * Every permission claim the page makes is rendered from THIS module, and
 * `apps/web/test/security-details.test.ts` locks each list against the actual
 * policy statements in `packages/cdk/src/bootstrap/bootstrap-stack.ts` — so
 * the copy can never drift from what the customer actually deploys. Do not
 * paraphrase these lists in JSX; render them from here.
 *
 * The design being disclosed (todo 8, two-phase):
 *   - Phase 1 (install-time): write relay logs + read/write the relay's own
 *     bootstrap-generated credential secret. Nothing else.
 *   - Phase 2 (post-first-contact): provisioner permissions to apply the
 *     versioned application stack. Every WRITE action is constrained by the
 *     `deployz:installation` tag boundary. The one exception is read-only: the
 *     load balancer's `Describe*` actions (listeners, listener certificates,
 *     tags, rules) cannot be scoped by tag at all — AWS does not support
 *     resource-level or condition-key restrictions on those API calls — so
 *     they are granted without a tag condition. Defined at install time but
 *     NOT attached until the control plane attaches it after the relay's
 *     first contact. Includes requesting and managing the TLS certificate for
 *     a custom domain you configure, and attaching it to the deployment's
 *     load balancer (custom-domains MVP).
 *   - A permissions boundary (union of phase 1 + phase 2) caps the relay role
 *     forever — its permissions can never grow beyond what is listed here.
 *   - Data boundary (§16): the relay writes logs but is never granted
 *     `logs:GetLogEvents` / `logs:FilterLogEvents` — it cannot read logs back.
 */

/** Phase 1 — write the relay's own activity log. */
export const PHASE_1_LOG_WRITE_ACTIONS = [
  'logs:CreateLogGroup',
  'logs:CreateLogStream',
  'logs:PutLogEvents',
] as const;

/** Phase 1 — read/write the relay's own credential secret (scoped to that secret only). */
export const PHASE_1_SECRET_ACTIONS = [
  'secretsmanager:GetSecretValue',
  'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret',
  'secretsmanager:DescribeSecret',
] as const;

/** Phase 2 — create/update the application stack (requires the request tag). */
export const PHASE_2_CREATE_STACK_ACTIONS = [
  'cloudformation:CreateStack',
  'cloudformation:UpdateStack',
  'cloudformation:CreateChangeSet',
  'cloudformation:ExecuteChangeSet',
] as const;

/** Phase 2 — manage/remove the application stack (requires the resource tag). */
export const PHASE_2_MANAGE_STACK_ACTIONS = [
  'cloudformation:DeleteStack',
  'cloudformation:DeleteChangeSet',
  'cloudformation:DescribeStacks',
  'cloudformation:DescribeStackEvents',
  'cloudformation:DescribeStackResources',
] as const;

/** Phase 2 — reconcile the application's own resources (requires the resource tag). */
export const PHASE_2_APP_RESOURCE_ACTIONS = [
  'ecs:UpdateService',
  'ecs:DeleteService',
  'ecs:DescribeServices',
  'rds:ModifyDBInstance',
  'rds:DeleteDBInstance',
  'rds:DescribeDBInstances',
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetHealth',
] as const;

/** Phase 2 — request and manage the TLS certificate for a custom domain you configure (requires the request tag). */
export const PHASE_2_ACM_REQUEST_ACTIONS = [
  'acm:RequestCertificate',
  'acm:AddTagsToCertificate',
] as const;

/** Phase 2 — read and remove that certificate (requires the resource tag). */
export const PHASE_2_ACM_MANAGE_ACTIONS = [
  'acm:DescribeCertificate',
  'acm:DeleteCertificate',
  'acm:ListTagsForCertificate',
] as const;

/** Phase 2 — attach the certificate to the deployment's load balancer (custom-domains MVP). */
export const PHASE_2_DOMAIN_INGRESS_ACTIONS = [
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeListenerCertificates',
  'elasticloadbalancing:DescribeTags',
  'elasticloadbalancing:DescribeRules',
  'elasticloadbalancing:CreateListener',
  'elasticloadbalancing:ModifyListener',
  'elasticloadbalancing:DeleteListener',
  'elasticloadbalancing:AddListenerCertificates',
  'elasticloadbalancing:RemoveListenerCertificates',
] as const;

/** Phase 2 — hand the application stack's own service role to the deployment service. */
export const PHASE_2_PASS_ROLE_ACTION = 'iam:PassRole';
export const PASS_ROLE_RESOURCE_ARN = 'arn:aws:iam::*:role/deployz/*';
export const PASSED_TO_SERVICE = 'cloudformation.amazonaws.com';

/** The tag boundary every phase-2 action is constrained by. */
export const TAG_BOUNDARY_KEY = 'deployz:installation';
export const REQUEST_TAG_CONDITION = 'aws:RequestTag/deployz:installation';
export const RESOURCE_TAG_CONDITION = 'aws:ResourceTag/deployz:installation';

/**
 * §16 data boundary — these are NEVER granted to the relay, anywhere in the
 * template. It writes its own activity log; it cannot read any logs back.
 */
export const DENIED_LOG_READ_ACTIONS = [
  'logs:GetLogEvents',
  'logs:FilterLogEvents',
] as const;

/**
 * §45 "exact AWS resources created" — distinct from the IAM action lists
 * above. These are the actual resources the bootstrap + application stacks
 * provision inside the customer account.
 */
export const AWS_RESOURCES_CREATED = [
  'A dedicated private network (subnets, an internet gateway, route tables)',
  'A load balancer with an HTTPS listener',
  'A managed container service running the application',
  'An RDS PostgreSQL database (when the application requires one)',
  'An S3 bucket (when the application requires file storage)',
  'A Secrets Manager secret for the relay’s own credentials, plus one per configured application secret',
  'CloudWatch log groups and alarms for the application and the relay',
  'The Deployz relay (a small scheduled job that runs in your account)',
  'A dedicated execution role for the relay, bounded by the permissions boundary described below',
] as const;

/**
 * §16/§45 "data sent to Deployz" — operational metadata only. Mirrors §16's
 * list verbatim.
 */
export const DATA_SENT_TO_DEPLOYZ = [
  'Installation ID',
  'AWS account ID',
  'AWS region',
  'Release version',
  'Deployment state',
  'Infrastructure status',
  'Resource identifiers',
  'Deployment timestamps',
  'Health state',
  'Structured AWS deployment errors',
] as const;

/**
 * §16/§45 "data NOT sent to Deployz" — everything customer-owned stays in the
 * customer's AWS account. Mirrors §16's list verbatim, plus the explicit
 * raw-logs guarantee.
 */
export const DATA_NOT_SENT_TO_DEPLOYZ = [
  'Your application runtime and its in-memory data',
  'Your PostgreSQL data',
  'Your S3 data',
  'Your application secrets',
  'Your application CloudWatch logs',
] as const;

export const RAW_LOGS_GUARANTEE =
  'Deployz does not automatically copy your raw application logs outside your AWS account.';

/** §45 "how to revoke Deployz". */
export const REVOKE_STEPS = [
  'Delete the deployz-bootstrap stack from your AWS account (or delete the relay’s execution role directly).',
  'The relay immediately loses the ability to call out to Deployz — there is no inbound path for Deployz to re-establish contact.',
  'Deployz marks the deployment Disconnected once it stops hearing from the relay, and it stops being billed.',
] as const;

/** §45 "how deletion works" — mirrors §63's distinctions. */
export const DELETION_STEPS = [
  'From the Deployz dashboard, the vendor requests "Disconnect Deployment" for your installation.',
  'Deployz instructs the relay to remove the application, database, storage, and networking it created — only resources tagged with your installation ID.',
  'Your AWS-native RDS backups follow your account’s own backup/retention settings and are not deleted by Deployz unless you request a final snapshot.',
  'The bootstrap stack and relay role are yours to remove at any time (see "How to revoke Deployz" above) — Deployz does not remove them for you.',
  'Deployz’s own operational metadata for the deployment (§16: IDs, state, timestamps — never your application data) is retained for your records and billing history.',
] as const;

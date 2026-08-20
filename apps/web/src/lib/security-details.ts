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
 *     versioned application stack, ALL constrained by the `deployz:installation`
 *     tag boundary. Defined at install time but NOT attached until the control
 *     plane attaches it after the relay's first contact.
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

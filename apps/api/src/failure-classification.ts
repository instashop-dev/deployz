import type { FailureCode } from '@deployz/contracts';

/**
 * §61 server-side failure refinement — deterministic, ordered rules that
 * sharpen the relay's coarse failure codes using evidence the control plane
 * already holds: the relay's free-text error and the persisted CloudFormation
 * stack events for the failed job.
 *
 * Why here and not in the relay: relay code ships into customer accounts and
 * existing installations never update, so a relay-side classifier would fix
 * nothing already deployed. The relay's executors hardcode one code per
 * failure site (every INSTALL failure is STACK_CREATE_FAILED, most thrown
 * exceptions become AWS_PERMISSION_DENIED), which makes the §29 remediation
 * copy wrong exactly when the vendor needs it. Refining at result ingestion
 * fixes every installation at once.
 *
 * Refinement only ever SHARPENS a coarse code — a specific code the relay
 * genuinely classified (ECS_DEPLOYMENT_FAILED, MISSING_SECRET, ...) is never
 * second-guessed.
 */

/** Stack-event evidence, in stored (oldest-first) order. */
export interface FailureStackEvent {
  readonly resourceType: string;
  readonly resourceStatus: string;
  readonly resourceStatusReason: string | null;
}

/** The coarse codes the relay assigns as defaults, eligible for refinement. */
const REFINABLE_CODES: ReadonlySet<string> = new Set([
  'STACK_CREATE_FAILED',
  'STACK_DELETE_FAILED',
  'AWS_PERMISSION_DENIED',
  'UNKNOWN',
]);

/** CloudFormation's own cancellation noise — never the root cause. */
const CANCELLATION_NOISE = /resource creation cancelled|resource update cancelled/i;

/**
 * The relay's own state-persistence failure phrases (its `failure()` helper
 * and deferral-marker write path). These come from relay code, not from AWS
 * — when they appear, nothing was necessarily wrong with the customer's
 * resources; the relay itself failed to record its own progress. That fault
 * is on Deployz's side of the trust boundary, not the customer's.
 */
const RELAY_STATE_WRITE_FAILURE = /could not record that it must report back|install could not run:/;

function isFailedEvent(event: FailureStackEvent): boolean {
  return (
    /(_FAILED)$/.test(event.resourceStatus) &&
    event.resourceType !== 'AWS::CloudFormation::Stack' &&
    !(event.resourceStatusReason !== null && CANCELLATION_NOISE.test(event.resourceStatusReason))
  );
}

function textEvidence(errorText: string | null, events: FailureStackEvent[]): string {
  const reasons = events
    .filter(isFailedEvent)
    .map((event) => event.resourceStatusReason ?? '')
    .join('\n');
  return `${errorText ?? ''}\n${reasons}`.toLowerCase();
}

/**
 * Refine a relay-reported failure code. Returns the sharper code, or the
 * reported one unchanged when nothing in the evidence justifies overriding
 * it. `null` stays `null` only when no evidence matches either — an
 * unclassified failure with recognisable evidence gains a code.
 */
export function refineFailureCode(input: {
  reported: FailureCode | null;
  errorText: string | null;
  stackEvents: readonly FailureStackEvent[];
}): FailureCode | null {
  const { reported, errorText } = input;
  if (reported !== null && !REFINABLE_CODES.has(reported)) return reported;

  const events = [...input.stackEvents];
  const text = textEvidence(errorText, events);
  const firstFailed = events.find(isFailedEvent);
  const failedType = firstFailed?.resourceType ?? '';
  const failedReason = (firstFailed?.resourceStatusReason ?? '').toLowerCase();

  // 1. SCP denial — an AccessDenied whose message carries the org-policy
  //    signature. Checked before plain permission denial: the remediation is
  //    entirely different (the customer's AWS organization, not the role).
  if (/service control policy|explicit deny/.test(text)) return 'AWS_SCP_BLOCKED';

  // 2. Quota/limit exhaustion (includes the CloudFormation phrasing "The
  //    maximum number of <resource> has been reached").
  if (/limitexceeded|limit exceeded|quota|toomanyrequests|too many requests|maximum number of/.test(text)) {
    return 'QUOTA_EXCEEDED';
  }

  // 3. Image pull failures (ECS task-level or CodeBuild-side wording).
  if (/cannotpullcontainererror|pull access denied|no basic auth credentials|failed to pull image|image.*not found.*repository/.test(text)) {
    return 'IMAGE_PULL_FAILED';
  }

  // 4. Plain IAM denial.
  if (/is not authorized to perform|accessdenied|api: .*access denied|not authorized/.test(text)) {
    return 'AWS_PERMISSION_DENIED';
  }

  // 5. The failed resource itself names the component.
  if (failedType.startsWith('AWS::RDS::')) return 'DATABASE_CREATE_FAILED';
  if (failedType.startsWith('AWS::ElastiCache::')) return 'REDIS_PROVISIONING_FAILED';
  if (failedType.startsWith('AWS::ECS::')) {
    return /health check/.test(failedReason) ? 'IMAGE_HEALTH_CHECK_FAILED' : 'CONTAINER_START_FAILED';
  }

  // 6. The relay's own state-persistence failure — checked after every
  //    AWS-side signal above so a genuine resource failure always wins, and
  //    only for the two coarse codes the relay's INSTALL executor actually
  //    reports before this evidence would apply: nothing rolled back here,
  //    the relay just failed to record that it had to report back.
  if ((reported === 'STACK_CREATE_FAILED' || reported === 'UNKNOWN') && RELAY_STATE_WRITE_FAILURE.test(text)) {
    return 'RELAY_STATE_WRITE_FAILED';
  }

  return reported;
}

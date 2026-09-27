import type { FailureCode, FailureEvidence } from '@deployz/contracts';

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

/**
 * Phase 1 container-exit signatures — sharper than "the container exited":
 * what the exiting process said, whether that rode the relay's structured
 * evidence or the free text it was flattened into. Prior art:
 * scripts/repository-deployment/classify.ts.
 */
/** A refused Postgres connection — port 5432, or a postgres host refusing. */
const DATABASE_CONNECTION_SIGNATURE =
  /ECONNREFUSED[^\n]{0,120}(?::5432\b|\bpostgres\b)|\bpostgres\b[^\n]{0,120}ECONNREFUSED/i;
/** A required variable the container itself says is absent (case-sensitive). */
const MISSING_SECRET_SIGNATURE = /Error: [A-Z][A-Z0-9_]{3,} (?:is|was) (?:not set|not|missing|required)/;
/** The port the container wants is taken or not permitted. */
const PORT_SIGNATURE = /EADDRINUSE|listen EACCES|address already in use|port already in use/i;

function isFailedEvent(event: FailureStackEvent): boolean {
  return (
    /(_FAILED)$/.test(event.resourceStatus) &&
    event.resourceType !== 'AWS::CloudFormation::Stack' &&
    !(event.resourceStatusReason !== null && CANCELLATION_NOISE.test(event.resourceStatusReason))
  );
}

function textEvidence(
  errorText: string | null,
  evidence: FailureEvidence | null | undefined,
  events: FailureStackEvent[],
): string {
  const reasons = events
    .filter(isFailedEvent)
    .map((event) => event.resourceStatusReason ?? '')
    .join('\n');
  const stoppedReason = evidence?.container?.stoppedReason ?? '';
  // Case preserved: the missing-variable signature is case-sensitive.
  return `${errorText ?? ''}\n${stoppedReason}\n${reasons}`;
}

/** Permission-rejection wording — the opposite of the expected retained-data
 *  cascade: here the relay was REFUSED, not blocked by a resource that must
 *  survive. Checked first so a genuine permission failure on a security
 *  group (or anything else) never reads as benign. */
const PERMISSION_DENIED_REASON =
  /not authorized to perform|accessdenied|unauthorizedoperation|explicit deny/i;

/** The retained database's elastic network interface — the physical pin that
 *  makes CloudFormation fail the security group / subnet it sits in when the
 *  stack is deleted around a retained RDS instance. Its appearance in a
 *  DELETE_FAILED reason is what distinguishes the expected post-Disconnect
 *  cascade from any other delete failure. */
const ENI_PIN_REASON = /\bnetwork interface\b|\beni-[0-9a-f]{8,}\b/i;

/**
 * Whether a DESTROY's DELETE_FAILED evidence is the expected retained-data
 * cascade: the resources CloudFormation could not delete are the retained
 * RDS instance itself (deletion protection) or resources pinned by its ENI
 * (security group, subnet). The relay's data-preserving recovery
 * (packages/relay/src/destroy.ts) retains exactly these, the delete then
 * completes, and the vendor's next step is Purge — not a retry loop.
 *
 * Evidence-only, per §61's server-side rule: classified from the persisted
 * stack events, never from the relay's coarse code. Returns false for
 * everything else — a permission failure on a security group, a delete
 * failure with no RDS/ENI evidence, an empty event set.
 *
 * The taxonomy currently has no dedicated code for this case (only the
 * classifier pipeline may extend @deployz/contracts' closed set), so
 * `refineFailureCode` still reports STACK_DELETE_FAILED; callers use this
 * predicate to soften the remediation copy until that code lands.
 */
export function isRetainedDataDeleteBlocked(stackEvents: readonly FailureStackEvent[]): boolean {
  return stackEvents.some((event) => {
    if (event.resourceStatus !== 'DELETE_FAILED' || event.resourceType === 'AWS::CloudFormation::Stack') {
      return false;
    }
    const reason = event.resourceStatusReason ?? '';
    if (PERMISSION_DENIED_REASON.test(reason)) return false;
    if (event.resourceType.startsWith('AWS::RDS::')) return true;
    return ENI_PIN_REASON.test(reason);
  });
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
  /** Phase 1 structured evidence, already redacted at ingest. Absent on old relays. */
  evidence?: FailureEvidence | null;
}): FailureCode | null {
  const { reported, errorText } = input;
  if (reported !== null && !REFINABLE_CODES.has(reported)) return reported;

  const events = [...input.stackEvents];
  const signatureText = textEvidence(errorText, input.evidence, events);
  const text = signatureText.toLowerCase();
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

  // 4b. A deployment artifact addressed in the wrong region — S3's
  //     PermanentRedirect wording (the region guard normally prevents this;
  //     when it happens anyway, the region is the cause, not the customer).
  if (/permanentredirect|must be addressed using the specified endpoint/.test(text)) {
    return 'REGION_NOT_SUPPORTED';
  }

  // 4c. Template artifact not found — S3 404 for a bootstrap or application
  //     template URL, distinct from a generic stack failure. The region guard
  //     normally prevents this; when it happens, the template was never
  //     published or was deleted.
  if (/the specified key does not exist|no such key|404.*template/i.test(text)) {
    return 'TEMPLATE_UNAVAILABLE';
  }

  // 4d. Container-exit signatures (Phase 1) — what the exiting process
  //     said, checked BEFORE the generic exit rule so a signature always
  //     outranks "the container exited". Every rule is gated on its own
  //     signature: a plain non-zero exit with none of them keeps today's
  //     behavior below, unchanged.
  if (DATABASE_CONNECTION_SIGNATURE.test(signatureText)) return 'DATABASE_CONNECTION_FAILED';
  if (MISSING_SECRET_SIGNATURE.test(signatureText)) return 'MISSING_SECRET';
  if (PORT_SIGNATURE.test(signatureText)) return 'PORT_MISMATCH';

  // 4e. The container itself — ECS wording for a task that never became
  //     healthy versus one whose process exited.
  if (/failed (?:elb|container) health checks|health checks? failed/.test(text)) return 'IMAGE_HEALTH_CHECK_FAILED';
  if (/essential container in task exited|exited with code|container exited|outofmemory/.test(text)) {
    return 'CONTAINER_START_FAILED';
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

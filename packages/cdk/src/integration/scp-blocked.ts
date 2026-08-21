/**
 * SCP-blocked error-signature catalog.
 *
 * Without a scratch Org (no AWS credentials), the realistic way to let the
 * classifier (todo 27) recognize a service-control-policy denial is to capture
 * the EXACT error signature AWS returns when an SCP explicitly denies an
 * action, and match against it.
 *
 * The canonical AWS denial message (IAM / CloudFormation / ECS all emit this
 * shape when an SCP's `Deny` statement blocks the operation):
 *
 *   User: arn:aws:iam::123456789012:user/example is not authorized to
 *   perform: ec2:RunInstances on resource: arn:aws:ec2:us-east-1:123456789012:
 *   instance/* with an explicit deny in a service control policy
 *
 * The error code is `AccessDenied` (SDK name `AccessDeniedException`). The two
 * markers that uniquely identify an SCP denial (as opposed to a plain IAM
 * policy denial) are:
 *
 *   1. `is not authorized to perform: <action>` — the authorization failure,
 *   2. `explicit deny in a service control policy` — the SCP-specific tail.
 *
 * `isScpBlocked` matches both; `extractBlockedAction` pulls the `<action>`
 * (an `service:Action` token like `ecs:RunTask`) out of the message. The
 * classifier maps a match to `AWS_SCP_BLOCKED` (§61).
 */

/** The AWS error code for a denied operation. */
export const SCP_BLOCKED_ERROR_CODE = 'AccessDenied';

/** The authorization-failure marker (prefixes the blocked action). */
export const SCP_AUTHZ_FAILED = 'is not authorized to perform:';

/** The SCP-specific tail that distinguishes an SCP denial from an IAM one. */
export const SCP_EXPLICIT_DENY_MARKER = 'explicit deny in a service control policy';

/** The canonical SCP denial signature, with wildcard placeholders. */
export const SCP_DENIAL_SIGNATURE =
  'User: arn:aws:iam::*:user/* is not authorized to perform: <action> ' +
  'on resource: <arn> with an explicit deny in a service control policy';

// ── Unknown-error normalization ───────────────────────────────────────────

/** Normalizes an unknown thrown value into a best-effort code + message. */
function normalizeError(
  error: unknown,
): { code: string | undefined; message: string | undefined } {
  if (typeof error === 'string') {
    return { code: undefined, message: error };
  }
  if (error instanceof Error) {
    // The generic `Error` name is not an AWS error code — treat it as
    // "unknown" so a re-thrown/wrapped SCP denial is still matched on its
    // message. Real AWS SDK errors carry a meaningful name (e.g.
    // `AccessDeniedException`, `ThrottlingException`).
    const name = error.name === 'Error' ? undefined : error.name;
    return { code: name, message: error.message };
  }
  if (typeof error === 'object' && error !== null) {
    const shape = error as Record<string, unknown>;
    const code = firstString(shape['code'], shape['Code'], shape['name']);
    const message = firstString(shape['message'], shape['Message']);
    return { code, message };
  }
  return { code: undefined, message: undefined };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return undefined;
}

// ── Classification ────────────────────────────────────────────────────────

/**
 * Recognizes an SCP-blocked error from its signature.
 *
 * Returns true only when the error's message contains BOTH the
 * authorization-failure marker AND the SCP-specific `explicit deny in a
 * service control policy` tail. If the error exposes a code, a non-AccessDenied
 * code short-circuits to false.
 */
export function isScpBlocked(error: unknown): boolean {
  const { code, message } = normalizeError(error);

  if (code !== undefined && !isAccessDeniedCode(code)) {
    return false;
  }
  if (message === undefined) {
    return false;
  }

  return (
    message.includes(SCP_AUTHZ_FAILED) &&
    message.includes(SCP_EXPLICIT_DENY_MARKER)
  );
}

/**
 * Extracts the blocked action (`service:Action`, e.g. `ecs:RunTask`) from an
 * SCP-blocked error, or `null` if the error is not SCP-blocked or the action
 * cannot be parsed.
 */
export function extractBlockedAction(error: unknown): string | null {
  if (!isScpBlocked(error)) {
    return null;
  }
  const { message } = normalizeError(error);
  if (message === undefined) {
    return null;
  }

  // AWS actions are always `service:Action` tokens (no spaces).
  const match = message.match(/is not authorized to perform:\s*([A-Za-z0-9-]+:[A-Za-z0-9*]+)/);
  return match?.[1] ?? null;
}

function isAccessDeniedCode(code: string): boolean {
  return code === SCP_BLOCKED_ERROR_CODE || code === 'AccessDeniedException';
}

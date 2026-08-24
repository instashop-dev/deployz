/**
 * Relay authentication — installation-token auth + rotation with grace window.
 *
 * The relay reads the bootstrap-generated credential from Secrets Manager,
 * authenticates to the control plane with it, and supports token rotation
 * with a grace window: during rotation, both old and new tokens are accepted
 * for N polls, then the old token is rejected.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Secrets Manager client interface (injectable seam for testing). */
export interface SecretsClient {
  getSecretValue(params: { SecretId: string }): Promise<{ SecretString: string | undefined }>;
}

/** HTTP fetch interface (injectable seam for testing). */
export interface FetchFn {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
}

/** The auth state the relay maintains across polls. */
export interface AuthState {
  /** The installation identifier (from DEPLOYZ_INSTALLATION_ID env var). */
  readonly installationId: string;
  /** The current bearer token for control-plane authentication. */
  token: string;
  /** Whether the installation has been registered with the control plane. */
  registered: boolean;
  /** The previous token during rotation (undefined when not rotating). */
  oldToken: string | undefined;
  /** Number of polls remaining in the grace window (0 = grace expired). */
  gracePollsRemaining: number;
}

/** Number of polls the old token remains valid during rotation. */
export const TOKEN_ROTATION_GRACE_POLLS = 3;

// ── Auth operations ──────────────────────────────────────────────────────────

/**
 * Read the bootstrap-generated credential from Secrets Manager.
 *
 * The secret was minted by CloudFormation at deploy time with shape
 * `{ "token": "<64-char random>" }`. The relay reads it on every cold start
 * and caches it in the AuthState.
 */
export async function readCredential(
  secretsClient: SecretsClient,
  secretArn: string,
): Promise<string> {
  const response = await secretsClient.getSecretValue({ SecretId: secretArn });
  if (!response.SecretString) {
    throw new Error('Credential secret has no SecretString');
  }
  const parsed: unknown = JSON.parse(response.SecretString);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('token' in parsed) ||
    typeof (parsed as Record<string, unknown>).token !== 'string'
  ) {
    throw new Error('Credential secret missing "token" field');
  }
  return (parsed as { token: string }).token;
}

/** Outcome of an enrollment attempt. */
export type RegistrationResult = 'registered' | 'rejected' | 'retry';

/**
 * Enroll the installation with the control plane on first contact.
 *
 * The enrollment code is what identifies the DEPLOYMENT: this installation id
 * is minted here, inside the customer's account, so the control plane has
 * never seen it before this call and cannot look anything up by it. The code
 * comes from the bootstrap stack's EnrollmentCode parameter, is single use,
 * and the control plane burns it when it binds this id and token.
 *
 * Returns:
 *   'registered' — bound (or an identical replay of an earlier bind)
 *   'rejected'   — 409: the code is already spent by a DIFFERENT relay, or
 *                  404: no such code. Retrying cannot fix either, and
 *                  hammering the endpoint would bury the vendor's alert.
 *   'retry'      — transient; the next poll tries again.
 */
export async function registerInstallation(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  installationId: string,
  token: string,
  enrollmentCode: string,
): Promise<RegistrationResult> {
  const url = `${controlPlaneUrl}/api/relay/register`;
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ installationId, enrollmentCode }),
  });
  if (response.status === 200 || response.status === 201) return 'registered';
  if (response.status === 404 || response.status === 409) return 'rejected';
  return 'retry';
}

/**
 * Build the authorization header for a poll request.
 *
 * During rotation, sends both tokens so the control plane can validate
 * against either one. After the grace window, only the new token is sent.
 */
export function buildAuthHeaders(state: AuthState): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.token}`,
  };
  if (state.oldToken && state.gracePollsRemaining > 0) {
    headers['X-Deployz-Old-Token'] = state.oldToken;
  }
  return headers;
}

/**
 * Process a token rotation response from the control plane.
 *
 * The control plane signals rotation by including an `X-Deployz-New-Token`
 * header in any response. When detected, the relay stores the current token
 * as oldToken, adopts the new token, and starts the grace counter.
 */
export function processRotationResponse(
  state: AuthState,
  newTokenHeader: string | null,
): void {
  if (!newTokenHeader) return;

  // If we're already rotating and get ANOTHER new token, collapse:
  // discard the old-old token, the current token becomes oldToken,
  // and the new-new token becomes current. Reset grace.
  if (state.oldToken) {
    state.oldToken = state.token;
  } else {
    state.oldToken = state.token;
  }
  state.token = newTokenHeader;
  state.gracePollsRemaining = TOKEN_ROTATION_GRACE_POLLS;
}

/**
 * Decrement the grace counter after each poll.
 *
 * When gracePollsRemaining reaches 0, the old token is discarded.
 */
export function decrementGrace(state: AuthState): void {
  if (state.gracePollsRemaining > 0) {
    state.gracePollsRemaining -= 1;
    if (state.gracePollsRemaining === 0) {
      state.oldToken = undefined;
    }
  }
}

/**
 * Create a fresh AuthState from the installation id and credential token.
 */
export function createAuthState(installationId: string, token: string): AuthState {
  return {
    installationId,
    token,
    registered: false,
    oldToken: undefined,
    gracePollsRemaining: 0,
  };
}
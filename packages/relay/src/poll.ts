/**
 * Relay poll loop — fetch commands from the control plane, execute them,
 * and report results back.
 *
 * The relay is egress-only: it calls OUT to the control plane; the control
 * plane never reaches INTO the customer account. Each poll cycle:
 *
 *   1. Authenticate (register on first contact, then bearer token)
 *   2. Fetch pending commands for this installation
 *   3. Execute each command (with idempotency)
 *   4. Report results + observed state back to the control plane (§59)
 */

import type { RelayCommand, RelayCommandResult } from './commands.js';
import { dispatchCommand, IdempotencyStore, type CommandExecutor } from './commands.js';
import {
  buildAuthHeaders,
  decrementGrace,
  processRotationResponse,
  registerInstallation,
  type AuthState,
  type FetchFn,
} from './auth.js';
import type { VerificationResult } from './verify.js';

// ── Control-plane API shapes ─────────────────────────────────────────────────

/** Response from GET /api/relay/commands */
interface PendingCommandsResponse {
  commands: RelayCommand[];
}

/** Payload for POST /api/relay/commands/:id/result */
interface CommandReportPayload {
  commandId: string;
  idempotencyKey: string;
  success: boolean;
  output?: Record<string, unknown>;
  error?: string;
  failureCode?: string;
}

/** Payload for POST /api/relay/health (§59 desired-vs-observed) */
interface HealthReportPayload {
  installationId: string;
  observedState: Record<string, unknown>;
}

// ── Poll context ─────────────────────────────────────────────────────────────

/** Injectable dependencies for the poll loop (seam for testing). */
export interface PollDependencies {
  fetchFn: FetchFn;
  controlPlaneUrl: string;
  installationId: string;
  /** Single-use code from the bootstrap stack; identifies the deployment. */
  enrollmentCode: string;
  executors: Readonly<Record<string, CommandExecutor>>;
  idempotency: IdempotencyStore;
  /**
   * §59 observed state. Optional so the poll loop stays usable without AWS —
   * when it is absent, or throws, `infraHealth` stays null rather than
   * reporting a healthy-looking absence of information.
   */
  observe?: () => Promise<VerificationResult>;
}

/** Result of a single poll cycle. */
export interface PollResult {
  /** Number of commands fetched. */
  fetched: number;
  /** Number of commands executed (including idempotent cache hits). */
  executed: number;
  /** Number of commands that succeeded. */
  succeeded: number;
  /** Number of commands that failed. */
  failed: number;
  /** Whether the poll completed without transport errors. */
  ok: boolean;
  /** Error message if the poll itself failed (not individual commands). */
  error?: string;
  /** Set when retrying cannot help — the caller should stop, not back off. */
  fatal?: boolean;
}

// ── Poll loop ────────────────────────────────────────────────────────────────

/**
 * Execute one poll cycle: fetch pending commands, execute them, report results.
 *
 * On first contact (authState.registered === false), registers the installation
 * with the control plane before fetching commands.
 */
export async function pollOnce(
  deps: PollDependencies,
  authState: AuthState,
): Promise<PollResult> {
  const { fetchFn, controlPlaneUrl, installationId, enrollmentCode, executors, idempotency, observe } = deps;

  // ── 1. Enroll on first contact ────────────────────────────────────────
  if (!authState.registered) {
    const result = await registerInstallation(
      fetchFn,
      controlPlaneUrl,
      installationId,
      authState.token,
      enrollmentCode,
    );
    if (result !== 'registered') {
      return {
        fetched: 0,
        executed: 0,
        succeeded: 0,
        failed: 0,
        ok: false,
        // A rejection is final: the code is spent by another relay, or it is
        // not a code the control plane knows. The vendor has to reconnect the
        // deployment, which mints a new one — retrying here cannot help.
        error:
          result === 'rejected'
            ? 'Enrollment rejected — this installation is already connected. Ask the vendor to reconnect it.'
            : 'Enrollment could not be completed — will try again on the next poll.',
        ...(result === 'rejected' ? { fatal: true } : {}),
      };
    }
    authState.registered = true;
  }

  // ── 2. Fetch pending commands ─────────────────────────────────────────
  const authHeaders = buildAuthHeaders(authState);
  let commandsResponse: { status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> };

  try {
    commandsResponse = await fetchFn(
      `${controlPlaneUrl}/api/relay/commands?installationId=${encodeURIComponent(installationId)}`,
      { headers: authHeaders },
    );
  } catch (err) {
    return {
      fetched: 0,
      executed: 0,
      succeeded: 0,
      failed: 0,
      ok: false,
      error: `Failed to fetch commands: ${String(err)}`,
    };
  }

  // Check for token rotation signal in response headers.
  processRotationResponse(authState, commandsResponse.headers.get('X-Deployz-New-Token'));

  if (commandsResponse.status !== 200) {
    return {
      fetched: 0,
      executed: 0,
      succeeded: 0,
      failed: 0,
      ok: false,
      error: `Control plane returned HTTP ${commandsResponse.status}`,
    };
  }

  const body = (await commandsResponse.json()) as PendingCommandsResponse;
  const commands = body.commands;

  if (!Array.isArray(commands) || commands.length === 0) {
    // Still report observed state (§59) on an idle poll — most polls have no
    // commands, and that is exactly when infrastructure drift needs catching.
    await reportHealth(fetchFn, controlPlaneUrl, authHeaders, installationId, idempotency, observe);
    decrementGrace(authState);
    return { fetched: 0, executed: 0, succeeded: 0, failed: 0, ok: true };
  }

  // ── 3. Execute each command ───────────────────────────────────────────
  let succeeded = 0;
  let failed = 0;

  for (const command of commands) {
    const result = await dispatchCommand(command, executors, idempotency);

    if (result.success) {
      succeeded += 1;
    } else {
      failed += 1;
    }

    // ── 4. Report result back to the control plane ───────────────────
    await reportCommandResult(fetchFn, controlPlaneUrl, authHeaders, result);
  }

  // ── 5. Report observed state (§59) ────────────────────────────────────
  await reportHealth(fetchFn, controlPlaneUrl, authHeaders, installationId, idempotency, observe);

  decrementGrace(authState);

  return {
    fetched: commands.length,
    executed: commands.length,
    succeeded,
    failed,
    ok: true,
  };
}

// ── Reporting helpers ────────────────────────────────────────────────────────

async function reportCommandResult(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  result: RelayCommandResult,
): Promise<void> {
  const payload: CommandReportPayload = {
    commandId: result.commandId,
    idempotencyKey: result.idempotencyKey,
    success: result.success,
    ...(result.output ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
  };

  try {
    await fetchFn(
      `${controlPlaneUrl}/api/relay/commands/${encodeURIComponent(result.commandId)}/result`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    // Best-effort reporting — the control plane will re-deliver the command
    // on the next poll if it doesn't receive the result.
  }
}

async function reportHealth(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  installationId: string,
  idempotency: IdempotencyStore,
  observe: PollDependencies['observe'],
): Promise<void> {
  let infraHealth: VerificationResult | null = null;
  if (observe) {
    try {
      infraHealth = await observe();
    } catch {
      // An observation we could not take is not an observation. Leaving this
      // null is honest; substituting a default would not be.
      infraHealth = null;
    }
  }

  const observedState: Record<string, unknown> = {
    idempotencyKeysTracked: idempotency.size,
    lastPoll: new Date().toISOString(),
    runningVersion: null,
    observedConfig: null,
    infraHealth,
  };

  const payload: HealthReportPayload = {
    installationId,
    observedState,
  };

  try {
    await fetchFn(`${controlPlaneUrl}/api/relay/health`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort health reporting.
  }
}
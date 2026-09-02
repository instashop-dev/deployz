/**
 * Relay poll loop — fetch commands from the control plane, execute them,
 * and report results back.
 *
 * The relay is egress-only: it calls OUT to the control plane; the control
 * plane never reaches INTO the customer account. Each poll cycle:
 *
 *   1. Authenticate (register on first contact, then bearer token)
 *   2. Finish and report anything an earlier cycle deferred
 *   3. Fetch pending commands for this installation
 *   4. Execute each command (with idempotency)
 *   5. Report results + observed state back to the control plane (§59)
 *
 * Step 2 exists because not every command fits in one invocation. An
 * INSTALL that is still creating its stack when the Lambda has to return is
 * reported to nobody and picked up again here on the next tick — the
 * control plane never re-offers a job it has already handed out, so the
 * relay is the only thing that can remember it.
 */

import type { RelayCommandProgress } from '@deployz/contracts';

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
import type { RuntimeHealth } from './ecs-health.js';
import type { VerificationResult } from './verify.js';

// ── Control-plane API shapes ─────────────────────────────────────────────────

/** Response from GET /api/relay/commands */
interface PendingCommandsResponse {
  commands: RelayCommand[];
  /** Deployment facts the control plane passes along every poll. */
  deployment?: { redisRequired?: boolean };
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
  /** What is actually running in ECS, when it could be observed. */
  runningImageDigest?: string | null;
  /** Measured runtime health, when the observation ran. */
  healthStatus?: string;
  components?: Record<string, unknown>;
  /** Relay identity, re-reported every heartbeat so the control plane can
   *  self-repair missing account ids and refresh version/capabilities. */
  identity?: Record<string, unknown>;
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
  /**
   * Finishes work an earlier poll deferred, and returns the results that
   * are now ready to report.
   *
   * The control plane moves a job to `RUNNING` the moment it hands it out
   * and never offers it again, so a command the relay could not finish
   * inside one invocation has to be picked back up from the relay's own
   * durable record of it. This is where that happens. Returning an empty
   * array means "nothing owed, or still not finished".
   */
  resume?: () => Promise<RelayCommandResult[]>;
  /** Reported at enrollment and on every heartbeat (see identity.ts). */
  identity?: Record<string, unknown>;
  /** Observes the image digest actually running in ECS; null = unknown. */
  observeImage?: () => Promise<string | null>;
  /** Measures runtime health (ECS counts, target health, rollout state). */
  observeHealth?: () => Promise<RuntimeHealth>;
  /**
   * Receives the deployment facts the commands response carries, before the
   * cycle's health observation runs — the observe hook reads them to know
   * whether the installation should include a cache.
   */
  onDeploymentMeta?: (meta: { redisRequired: boolean }) => void;
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
  /** Commands started but not finished — no result reported for these. */
  deferred: number;
  /** Results for earlier-deferred commands that finished since the last poll. */
  resumed: number;
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
  const { fetchFn, controlPlaneUrl, installationId, enrollmentCode, executors, idempotency, observe, resume, identity, observeImage, observeHealth } =
    deps;

  // ── 1. Enroll on first contact ────────────────────────────────────────
  if (!authState.registered) {
    const result = await registerInstallation(
      fetchFn,
      controlPlaneUrl,
      installationId,
      authState.token,
      enrollmentCode,
      identity,
    );
    if (result !== 'registered') {
      return {
        fetched: 0,
        executed: 0,
        succeeded: 0,
        failed: 0,
        deferred: 0,
        resumed: 0,
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

  const authHeaders = buildAuthHeaders(authState);

  // ── 2. Finish anything an earlier poll deferred ───────────────────────
  //
  // Before asking for new work: a command the relay already owes an answer
  // to is the control plane's oldest open question, and the job it belongs
  // to is sitting in RUNNING until it gets one.
  let resumed = 0;
  if (resume) {
    let finished: RelayCommandResult[] = [];
    try {
      finished = await resume();
    } catch (err) {
      // A resume we could not run is not a reason to skip the whole poll —
      // the pending marker survives, so the next tick tries again.
      console.error(JSON.stringify({ event: 'relay:resume-failed', error: String(err) }));
    }
    for (const result of finished) {
      await reportCommandResult(fetchFn, controlPlaneUrl, authHeaders, result);
      resumed += 1;
    }
  }

  // ── 3. Fetch pending commands ─────────────────────────────────────────
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
      deferred: 0,
      resumed,
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
      deferred: 0,
      resumed,
      ok: false,
      error: `Control plane returned HTTP ${commandsResponse.status}`,
    };
  }

  const body = (await commandsResponse.json()) as PendingCommandsResponse;
  const commands = body.commands;
  if (body.deployment && typeof body.deployment.redisRequired === 'boolean') {
    deps.onDeploymentMeta?.({ redisRequired: body.deployment.redisRequired });
  }

  if (!Array.isArray(commands) || commands.length === 0) {
    // Still report observed state (§59) on an idle poll — most polls have no
    // commands, and that is exactly when infrastructure drift needs catching.
    await reportHealth(fetchFn, controlPlaneUrl, authHeaders, installationId, idempotency, observe, identity, observeImage, observeHealth);
    decrementGrace(authState);
    return { fetched: 0, executed: 0, succeeded: 0, failed: 0, deferred: 0, resumed, ok: true };
  }

  // ── 4. Execute each command ───────────────────────────────────────────
  let succeeded = 0;
  let failed = 0;
  let deferred = 0;

  for (const command of commands) {
    const result = await dispatchCommand(command, executors, idempotency);

    // A deferred command has been started, not finished. Reporting anything
    // now would settle a job that is still genuinely running: `success:
    // false` marks the deployment FAILED, and `success: true` is the exact
    // unearned Healthy this whole design exists to prevent.
    if (result.deferred) {
      deferred += 1;
      continue;
    }

    if (result.success) {
      succeeded += 1;
    } else {
      failed += 1;
    }

    // ── 5. Report result back to the control plane ───────────────────
    await reportCommandResult(fetchFn, controlPlaneUrl, authHeaders, result);
  }

  // ── 6. Report observed state (§59) ────────────────────────────────────
  await reportHealth(fetchFn, controlPlaneUrl, authHeaders, installationId, idempotency, observe, identity, observeImage, observeHealth);

  decrementGrace(authState);

  return {
    fetched: commands.length,
    executed: commands.length,
    succeeded,
    failed,
    deferred,
    resumed,
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

/**
 * Statuses already logged this container's lifetime — so a control plane
 * stuck returning the same non-2xx does not spam the log on every tick of
 * every in-flight install, while a genuinely new failure mode still gets
 * one line.
 */
const loggedProgressFailureStatuses = new Set<number>();

/**
 * Report a batch of CloudFormation stack events to the control plane, in
 * the same auth/fetch idiom as `reportCommandResult`.
 *
 * Progress is diagnostics, never an input to a lifecycle decision — so
 * unlike `reportCommandResult`, this returns whether the post was accepted
 * rather than swallowing the answer, which is what lets the stack-event
 * collector know whether to advance its cursor. It still never throws: a
 * control plane an older version doesn't recognize this route on (a 404) is
 * tolerated exactly like any other non-2xx.
 */
export async function reportCommandProgress(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  progress: RelayCommandProgress,
): Promise<boolean> {
  try {
    const response = await fetchFn(
      `${controlPlaneUrl}/api/relay/commands/${encodeURIComponent(progress.commandId)}/progress`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(progress),
      },
    );

    if (response.status >= 200 && response.status < 300) return true;

    if (!loggedProgressFailureStatuses.has(response.status)) {
      loggedProgressFailureStatuses.add(response.status);
      console.error(
        JSON.stringify({ event: 'relay:stack-events-report-failed', status: response.status }),
      );
    }
    return false;
  } catch {
    return false;
  }
}

async function reportHealth(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  installationId: string,
  idempotency: IdempotencyStore,
  observe: PollDependencies['observe'],
  identity?: Record<string, unknown>,
  observeImage?: PollDependencies['observeImage'],
  observeHealth?: PollDependencies['observeHealth'],
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

  // A digest observation failing must not fail the health report — the rest
  // of the payload is still true. null means "not observed", never a guess.
  let runningImageDigest: string | null = null;
  if (observeImage) {
    try {
      runningImageDigest = await observeImage();
    } catch {
      runningImageDigest = null;
    }
  }

  // Same rule for the health observation: a failure reports UNKNOWN rather
  // than sinking the heartbeat.
  let runtimeHealth: RuntimeHealth | null = null;
  if (observeHealth) {
    try {
      runtimeHealth = await observeHealth();
    } catch {
      runtimeHealth = null;
    }
  }

  const observedState: Record<string, unknown> = {
    idempotencyKeysTracked: idempotency.size,
    lastPoll: new Date().toISOString(),
    runningImageDigest,
    observedConfig: null,
    infraHealth,
    ...(runtimeHealth
      ? {
          desiredCount: runtimeHealth.desiredCount,
          runningCount: runtimeHealth.runningCount,
          unhealthyTargetCount: runtimeHealth.unhealthyTargetCount,
          pendingTargetCount: runtimeHealth.pendingTargetCount,
          unknownTargetCount: runtimeHealth.unknownTargetCount,
          deploymentRolloutState: runtimeHealth.deploymentRolloutState,
        }
      : {}),
  };

  const payload: HealthReportPayload = {
    installationId,
    observedState,
    runningImageDigest,
    ...(runtimeHealth
      ? { healthStatus: runtimeHealth.healthStatus, components: runtimeHealth.components }
      : {}),
    ...(identity ? { identity } : {}),
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
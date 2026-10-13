/**
 * Pending-command state — the one thing the relay has to remember between
 * invocations.
 *
 * An application stack takes longer to create than a Lambda is allowed to
 * run, so the invocation that starts an INSTALL is usually not the one that
 * learns how it ended. The control plane cannot help: it moves a job to
 * `RUNNING` the moment it hands it out and never offers it again, so a
 * command the relay does not report on stays unreported forever. The relay
 * therefore keeps the one fact it needs to finish the job later — which
 * command it owes an answer to — somewhere that outlives the container.
 *
 * SSM Parameter Store, rather than a second Secret: there is no extra
 * resource to create in the bootstrap template, and the parameter name
 * carries the installation id, so IAM scopes it by ARN without needing a
 * tag condition. The value can carry install-time secret parameter values
 * (an INSTALL payload), so it is written as a SecureString parameter.
 *
 * Nothing here throws. `inspect` tells a marker that is absent from one that
 * cannot be read, so a caller never mistakes an outage for "nothing pending";
 * a write or clear that fails says so in its return value, so the caller can
 * refuse to defer work it would not be able to pick back up.
 */

import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { FailureEvidence } from '@deployz/contracts';

import type { RelayCommandResult } from './commands.js';

/**
 * The terminal answer a settled pending marker carries. Kept in the marker so
 * a result report that failed to reach the control plane can be retried on the
 * next poll without provisioning anything again.
 */
export interface PersistedCommandResult {
  readonly success: boolean;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
  readonly failureCode?: string;
  readonly evidence?: FailureEvidence;
}

/** A command the relay started and still owes the control plane an answer to. */
export interface PendingCommand {
  /** The job id to POST the eventual result to. */
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly type: string;
  /** The stack whose progress decides the answer. */
  readonly stackName: string;
  /** ISO timestamp of when the relay took the command on. */
  readonly startedAt: string;
  /**
   * The command's original payload.
   *
   * Kept whole rather than as extracted fields so a resumed command is
   * checked against exactly the same expectations as the first attempt —
   * `redisRequired`, in particular, decides whether a missing cache is a
   * failure, and an install that starts strict must not finish lenient.
   */
  readonly payload: Record<string, unknown>;
  /**
   * Cross-invocation resume point for the stack-event collector. Optional so
   * a marker written by an older relay version, before this field existed,
   * still parses; a resumer that finds it absent just starts collecting
   * from `startedAt` instead of a prior cursor.
   */
  readonly stackEventsCursor?: { readonly lastEventAt: string };
  /**
   * Deploy-time migration state (DEPLOY_RELEASE only). One-off ECS task that
   * runs the migration command before the service update; written the moment
   * `runTask` returns so a migration that outlives one invocation resumes by
   * polling the SAME task instead of starting a second one. Optional so a
   * marker written by an older relay version still parses.
   */
  readonly migration?: { readonly taskArn: string; readonly completedAt?: string };
  /**
   * Whether the marker is still being worked (`running`) or carries a
   * terminal answer (`settled`). Optional so a marker written by an older
   * relay version, before this field existed, still parses; absent reads as
   * running.
   */
  readonly phase?: 'running' | 'settled';
  /**
   * The terminal answer for a settled marker, kept so a result report that
   * failed can be retried without provisioning again.
   */
  readonly result?: PersistedCommandResult;
  /** ISO timestamp of when the marker settled. */
  readonly settledAt?: string;
}

/**
 * What the store holds. `unreadable` covers a store that cannot be reached or
 * a marker that does not parse: the command's state is unknown, so a caller
 * must defer and mutate nothing.
 */
export type PendingRead =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly marker: PendingCommand }
  | { readonly state: 'unreadable'; readonly errorCode: string };

/**
 * Asks the control plane whether a command may still change AWS: `true` is
 * active, `false` superseded, `null` unknown.
 */
export type CheckAuthority = (commandId: string) => Promise<boolean | null>;

export interface PendingStore {
  /** The marker, or `null` when absent OR unreadable. Use `inspect` to tell them apart. */
  read(): Promise<PendingCommand | null>;
  inspect(): Promise<PendingRead>;
  /** `false` when the marker could not be persisted. */
  write(pending: PendingCommand): Promise<boolean>;
  /** `false` when the marker may still be there. */
  clear(): Promise<boolean>;
  /**
   * Write or clear the marker only while it still belongs to
   * `expectedCommandId`. A newer command's marker is never cleared or
   * overwritten, and creating a marker while none exists is refused (only
   * clearing an absent marker is a success).
   */
  compareAndSet(expectedCommandId: string, next: PendingCommand | null): Promise<boolean>;
}

/** Default parameter name for an installation's pending command. */
export function pendingParameterName(installationId: string): string {
  return `/deployz/${installationId}/pending-command`;
}

/**
 * SSM Standard-tier's maximum parameter value length. A marker over this
 * would fail `PutParameterCommand` with `ValidationException` anyway — the
 * guard in `write` below checks it first so an oversized marker is rejected
 * cheaply, with a clear reason, instead of via an SDK round trip.
 */
export const PENDING_MARKER_MAX_LENGTH = 4096;

/** In-memory store — the fallback when no parameter name is configured. */
export function memoryPendingStore(): PendingStore {
  let pending: PendingCommand | null = null;
  const store: PendingStore = {
    async read() {
      return pending;
    },
    async inspect() {
      return pending === null ? { state: 'absent' } : { state: 'present', marker: pending };
    },
    async write(next) {
      pending = next;
      return true;
    },
    async clear() {
      pending = null;
      return true;
    },
    async compareAndSet(expectedCommandId, next) {
      if (pending === null) {
        if (next === null) return true;
        console.error(JSON.stringify({ event: 'relay:pending-cas-refused', expectedCommandId }));
        return false;
      }
      if (pending.commandId !== expectedCommandId) {
        console.error(
          JSON.stringify({
            event: 'relay:pending-cas-refused',
            expectedCommandId,
            currentCommandId: pending.commandId,
          }),
        );
        return false;
      }
      return next === null ? store.clear() : store.write(next);
    },
  };
  return store;
}

/** The one method of the SDK client this module uses. */
interface SendsCommands {
  send(command: unknown): Promise<unknown>;
}

/** `{ name, message }` for a structured log line — never the pending value itself. */
function describeError(err: unknown): { name: string; message: string } {
  return err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: 'UnknownError', message: String(err) };
}

/**
 * Wrap an SSM client as a pending-command store.
 *
 * Split out from `createPendingStore` so it can be tested against a fake
 * client with no SDK construction, matching `toReader` in `./verify.ts` and
 * `toInstaller` in `./install.ts`.
 */
export function toPendingStore(client: SendsCommands, parameterName: string): PendingStore {
  const store: PendingStore = {
    async read(): Promise<PendingCommand | null> {
      const current = await store.inspect();
      return current.state === 'present' ? current.marker : null;
    },

    async inspect(): Promise<PendingRead> {
      try {
        // The marker is a SecureString (see `write`): without
        // `WithDecryption` SSM hands back the KMS ciphertext, which parses
        // as nothing pending and silently strands every deferred command.
        const response = (await client.send(
          new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
        )) as { Parameter?: { Value?: string } };

        const value = response.Parameter?.Value;
        if (value === undefined) return { state: 'absent' };
        const marker = parse(value);
        if (marker === null) {
          console.error(
            JSON.stringify({ event: 'relay:pending-marker-unreadable', parameterName }),
          );
          return { state: 'unreadable', errorCode: 'MalformedMarker' };
        }
        return { state: 'present', marker };
      } catch (err) {
        // Only `ParameterNotFound` proves nothing is pending. `AccessDenied`,
        // throttling and transport errors say nothing about the marker.
        if (err instanceof Error && err.name === 'ParameterNotFound') return { state: 'absent' };
        const error = describeError(err);
        console.error(
          JSON.stringify({ event: 'relay:pending-read-failed', parameterName, error }),
        );
        return { state: 'unreadable', errorCode: error.name };
      }
    },

    async write(pending: PendingCommand): Promise<boolean> {
      const value = JSON.stringify(pending);
      if (value.length > PENDING_MARKER_MAX_LENGTH) {
        // Cheaper and clearer than letting SSM reject it: `PutParameter`
        // would throw this exact ValidationException anyway.
        console.error(
          JSON.stringify({
            event: 'relay:pending-marker-too-large',
            parameterName,
            length: value.length,
          }),
        );
        return false;
      }

      try {
        await client.send(
          new PutParameterCommand({
            Name: parameterName,
            // SecureString: the pending payload can carry install-time
            // secret parameter values; the marker itself is never worth
            // forfeiting if the parameter leaks out of the account's SSM.
            Type: 'SecureString',
            Value: value,
            Overwrite: true,
          }),
        );
        return true;
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'relay:pending-write-failed',
            parameterName,
            error: describeError(err),
          }),
        );
        return false;
      }
    },

    async clear(): Promise<boolean> {
      try {
        await client.send(new DeleteParameterCommand({ Name: parameterName }));
        return true;
      } catch (err) {
        // Already gone is the state we wanted.
        if (err instanceof Error && err.name === 'ParameterNotFound') return true;
        console.error(
          JSON.stringify({
            event: 'relay:pending-clear-failed',
            parameterName,
            error: describeError(err),
          }),
        );
        return false;
      }
    },

    async compareAndSet(expectedCommandId, next): Promise<boolean> {
      const read = await store.inspect();
      if (read.state === 'unreadable') {
        logCasRefused(parameterName, expectedCommandId);
        return false;
      }
      if (read.state === 'absent') {
        if (next === null) return true;
        logCasRefused(parameterName, expectedCommandId);
        return false;
      }
      if (read.marker.commandId !== expectedCommandId) {
        logCasRefused(parameterName, expectedCommandId, read.marker.commandId);
        return false;
      }
      const applied = next === null ? await store.clear() : await store.write(next);
      if (!applied) {
        console.error(
          JSON.stringify({ event: 'relay:pending-cas-failed', parameterName, expectedCommandId }),
        );
      }
      return applied;
    },
  };
  return store;
}

/** One structured line for a refused compare-and-set — never the marker value. */
function logCasRefused(
  parameterName: string,
  expectedCommandId: string,
  currentCommandId?: string,
): void {
  console.error(
    JSON.stringify({
      event: 'relay:pending-cas-refused',
      parameterName,
      expectedCommandId,
      ...(currentCommandId !== undefined ? { currentCommandId } : {}),
    }),
  );
}

/** Production store — credentials come from the standard SDK chain. */
export function createPendingStore(parameterName: string, region?: string): PendingStore {
  return toPendingStore(new SSMClient(region === undefined ? {} : { region }), parameterName);
}

/** The terminal answer a settled marker holds, rebuilt as a reportable result. */
export function settledResultOf(pending: PendingCommand): RelayCommandResult | null {
  const result = pending.result;
  if (pending.phase !== 'settled' || !result) return null;
  return {
    commandId: pending.commandId,
    idempotencyKey: pending.idempotencyKey,
    success: result.success,
    ...(result.output ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    ...(result.evidence ? { evidence: result.evidence } : {}),
  };
}

const MAX_ERROR_LENGTH = 1000;
const MAX_OUTPUT_TEXT_LENGTH = 200;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Output entries small enough to keep: scalars, short text and lists of key names. */
function compactOutput(output: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (typeof value === 'boolean' || typeof value === 'number') kept[key] = value;
    else if (typeof value === 'string') kept[key] = clip(value, MAX_OUTPUT_TEXT_LENGTH);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) kept[key] = value;
  }
  return kept;
}

/**
 * Shrink a settled marker's result until the marker fits SSM's value limit.
 * Deterministic: first the error text is clipped, then the evidence goes, then
 * the output keeps only its scalars and key-name lists, then the output goes.
 * `success`, `failureCode` and a short error always survive.
 */
function fitSettledMarker(marker: PendingCommand): PendingCommand {
  const fits = (candidate: PendingCommand): boolean =>
    JSON.stringify(candidate).length <= PENDING_MARKER_MAX_LENGTH;
  if (fits(marker)) return marker;

  const result = marker.result as PersistedCommandResult;
  const { evidence: _evidence, ...withoutEvidence } = result;
  const clipped = (candidate: PersistedCommandResult, max: number): PersistedCommandResult => ({
    ...candidate,
    ...(candidate.error !== undefined ? { error: clip(candidate.error, max) } : {}),
  });
  const attempts: PersistedCommandResult[] = [
    clipped(result, MAX_ERROR_LENGTH),
    clipped(withoutEvidence, MAX_ERROR_LENGTH),
    ...(result.output ? [{ ...clipped(withoutEvidence, MAX_ERROR_LENGTH), output: compactOutput(result.output) }] : []),
  ];
  const { output: _output, ...bare } = withoutEvidence;
  attempts.push(clipped(bare, MAX_OUTPUT_TEXT_LENGTH));

  const chosen = attempts.find((attempt) => fits({ ...marker, result: attempt })) ?? attempts[attempts.length - 1]!;
  console.error(JSON.stringify({ event: 'relay:pending-result-truncated', commandId: marker.commandId }));
  return { ...marker, result: chosen };
}

/**
 * Persist a command's terminal answer as a settled marker BEFORE it is
 * reported, so a report that never arrives is retried from the marker instead
 * of running the command again. The marker keeps no payload: the answer is all
 * a settled command needs, and an install payload can carry secret values.
 *
 * `false` means the answer is not on record: the marker belongs to another
 * command, cannot be read, or could not be written. `createIfAbsent` is for an
 * executor whose command never wrote a marker; a resumer never recreates one.
 */
export async function settleMarker(
  store: PendingStore,
  pending: Pick<PendingCommand, 'commandId' | 'idempotencyKey' | 'type' | 'stackName' | 'startedAt'>,
  result: PersistedCommandResult,
  createIfAbsent: boolean,
): Promise<boolean> {
  const settled = fitSettledMarker({
    commandId: pending.commandId,
    idempotencyKey: pending.idempotencyKey,
    type: pending.type,
    stackName: pending.stackName,
    startedAt: pending.startedAt,
    payload: {},
    phase: 'settled',
    result: {
      success: result.success,
      ...(result.output ? { output: result.output } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
      ...(result.evidence ? { evidence: result.evidence } : {}),
    },
    settledAt: new Date().toISOString(),
  });
  const current = await store.inspect();
  if (current.state === 'absent' && createIfAbsent) return store.write(settled);
  if (current.state !== 'present') return false;
  return store.compareAndSet(pending.commandId, settled);
}

/**
 * An executor's terminal answer: recorded as settled first, then handed back
 * for reporting. An answer that cannot be recorded is still reported — the
 * mutation already happened, and silence would be worse.
 */
export async function reportSettled(
  store: PendingStore,
  pending: Pick<PendingCommand, 'commandId' | 'idempotencyKey' | 'type' | 'stackName' | 'startedAt'>,
  result: RelayCommandResult,
): Promise<RelayCommandResult> {
  await settleMarker(store, pending, result, true);
  return result;
}

/**
 * Write a running marker. A marker that is this command's own is replaced
 * only by compare-and-set; a store that cannot be read is never written blind.
 */
export async function saveMarker(store: PendingStore, marker: PendingCommand): Promise<boolean> {
  const current = await store.inspect();
  if (current.state === 'unreadable') return false;
  if (current.state === 'present' && current.marker.commandId === marker.commandId) {
    return store.compareAndSet(marker.commandId, marker);
  }
  return store.write(marker);
}

/** Defensive read of a settled marker's stored result; a malformed one is dropped. */
function parsePersistedResult(raw: unknown): PersistedCommandResult | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record['success'] !== 'boolean') return undefined;
  const output = record['output'];
  const evidence = record['evidence'];
  return {
    success: record['success'],
    ...(typeof output === 'object' && output !== null && !Array.isArray(output)
      ? { output: output as Record<string, unknown> }
      : {}),
    ...(typeof record['error'] === 'string' ? { error: record['error'] } : {}),
    ...(typeof record['failureCode'] === 'string' ? { failureCode: record['failureCode'] } : {}),
    ...(typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)
      ? { evidence: evidence as FailureEvidence }
      : {}),
  };
}

/**
 * A stored value that is not a pending command is treated as none. The
 * parameter is written only by this module, so the realistic cause is a
 * half-finished write or a hand edit — neither of which is a command worth
 * resuming.
 */
function parse(value: string): PendingCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  const required = ['commandId', 'idempotencyKey', 'type', 'stackName', 'startedAt'] as const;
  for (const field of required) {
    if (typeof candidate[field] !== 'string') return null;
  }

  const payload = candidate['payload'];
  const stackEventsCursorRaw = candidate['stackEventsCursor'];
  const stackEventsCursor =
    typeof stackEventsCursorRaw === 'object' &&
    stackEventsCursorRaw !== null &&
    typeof (stackEventsCursorRaw as Record<string, unknown>)['lastEventAt'] === 'string'
      ? { lastEventAt: (stackEventsCursorRaw as Record<string, unknown>)['lastEventAt'] as string }
      : undefined;

  const migrationRaw = candidate['migration'];
  const migration =
    typeof migrationRaw === 'object' && migrationRaw !== null
      ? (() => {
          const record = migrationRaw as Record<string, unknown>;
          if (typeof record['taskArn'] !== 'string') return undefined;
          const completedAt = record['completedAt'];
          const registeredArn = record['registeredArn'];
          return {
            taskArn: record['taskArn'] as string,
            ...(typeof registeredArn === 'string' ? { registeredArn } : {}),
            ...(typeof completedAt === 'string' ? { completedAt } : {}),
          };
        })()
      : undefined;

  const phaseRaw = candidate['phase'];
  const phase = phaseRaw === 'settled' || phaseRaw === 'running' ? phaseRaw : undefined;
  const result = parsePersistedResult(candidate['result']);
  const settledAt = typeof candidate['settledAt'] === 'string' ? candidate['settledAt'] : undefined;

  return {
    commandId: candidate['commandId'] as string,
    idempotencyKey: candidate['idempotencyKey'] as string,
    type: candidate['type'] as string,
    stackName: candidate['stackName'] as string,
    startedAt: candidate['startedAt'] as string,
    payload:
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
    ...(stackEventsCursor !== undefined ? { stackEventsCursor } : {}),
    ...(migration !== undefined ? { migration } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(settledAt !== undefined ? { settledAt } : {}),
  };
}

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
 * Nothing here throws. A store that cannot be read reports "nothing
 * pending"; a write or clear that fails says so in its return value, so the
 * caller can refuse to defer work it would not be able to pick back up.
 */

import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';

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
}

export interface PendingStore {
  read(): Promise<PendingCommand | null>;
  /** `false` when the marker could not be persisted. */
  write(pending: PendingCommand): Promise<boolean>;
  /** `false` when the marker may still be there. */
  clear(): Promise<boolean>;
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
  return {
    async read() {
      return pending;
    },
    async write(next) {
      pending = next;
      return true;
    },
    async clear() {
      pending = null;
      return true;
    },
  };
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
  return {
    async read(): Promise<PendingCommand | null> {
      try {
        // The marker is a SecureString (see `write`): without
        // `WithDecryption` SSM hands back the KMS ciphertext, which parses
        // as nothing pending and silently strands every deferred command.
        const response = (await client.send(
          new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
        )) as { Parameter?: { Value?: string } };

        const value = response.Parameter?.Value;
        if (value === undefined) return null;
        const pending = parse(value);
        if (pending === null) {
          console.error(
            JSON.stringify({ event: 'relay:pending-marker-unreadable', parameterName }),
          );
        }
        return pending;
      } catch {
        // `ParameterNotFound` and `AccessDenied` are the same answer to
        // "is there something to resume?" — no.
        return null;
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
  };
}

/** Production store — credentials come from the standard SDK chain. */
export function createPendingStore(parameterName: string, region?: string): PendingStore {
  return toPendingStore(new SSMClient(region === undefined ? {} : { region }), parameterName);
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
  };
}

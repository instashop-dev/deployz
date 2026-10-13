/**
 * Invocation lease — keeps one relay invocation running at a time.
 *
 * The schedule fires every minute and one invocation may run for up to five
 * minutes. Reserved concurrency is not an option (a new AWS account can have
 * a concurrency limit too low to reserve any), so the relay holds a lease in
 * the SSM parameter namespace it already owns (`/deployz/<installationId>/`).
 * An invocation that finds a live lease, or cannot read the lease, ends
 * without polling.
 *
 * SSM has no compare-and-delete, so a take-over of an expired lease is best
 * effort: two invocations can in theory take over at the same instant. This is
 * rare (a lease only expires after a crashed or timed-out invocation), and
 * every command is already idempotent.
 */

import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';

/** Extra time kept after the function timeout before a lease may be taken over. */
export const LEASE_MARGIN_MS = 30_000;

/** Function timeout when the Lambda context cannot say how long is left. */
const DEFAULT_RUN_MS = 5 * 60_000;

interface SendsCommands {
  send(command: unknown): Promise<unknown>;
}

interface LeaseRecord {
  invocationId: string;
  expiresAt: number;
}

export interface Lease {
  /** True only when this invocation now holds the lease. */
  acquire(): Promise<boolean>;
  /** Deletes the lease, only while it is still ours. Never throws. */
  release(): Promise<void>;
}

export function leaseParameterName(installationId: string): string {
  return `/deployz/${installationId}/invocation-lease`;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function parseRecord(value: string | undefined): LeaseRecord | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LeaseRecord>;
    if (typeof parsed.invocationId === 'string' && typeof parsed.expiresAt === 'number') {
      return { invocationId: parsed.invocationId, expiresAt: parsed.expiresAt };
    }
  } catch {
    // An unreadable record is treated as expired.
  }
  return null;
}

export function createLease(options: {
  client: SendsCommands;
  parameterName: string;
  invocationId: string;
  /** Milliseconds this invocation may run (the Lambda time left). */
  runMs?: number;
  now?: () => number;
}): Lease {
  const { client, parameterName, invocationId } = options;
  const now = options.now ?? Date.now;
  const runMs = options.runMs ?? DEFAULT_RUN_MS;

  const put = (): Promise<unknown> =>
    client.send(
      new PutParameterCommand({
        Name: parameterName,
        Type: 'String',
        Overwrite: false,
        Value: JSON.stringify({
          invocationId,
          expiresAt: now() + runMs + LEASE_MARGIN_MS,
        } satisfies LeaseRecord),
      }),
    );

  const read = async (): Promise<{ found: boolean; record: LeaseRecord | null }> => {
    try {
      const response = (await client.send(new GetParameterCommand({ Name: parameterName }))) as {
        Parameter?: { Value?: string };
      };
      return { found: true, record: parseRecord(response.Parameter?.Value) };
    } catch (err) {
      if (errorName(err) === 'ParameterNotFound') return { found: false, record: null };
      throw err;
    }
  };

  const remove = async (): Promise<void> => {
    try {
      await client.send(new DeleteParameterCommand({ Name: parameterName }));
    } catch (err) {
      if (errorName(err) !== 'ParameterNotFound') throw err;
    }
  };

  return {
    async acquire() {
      try {
        try {
          await put();
          return true;
        } catch (err) {
          if (errorName(err) !== 'ParameterAlreadyExists') throw err;
        }
        const { record } = await read();
        if (record !== null && record.expiresAt > now()) return false;
        // Expired, unreadable, or deleted since the put: take it over.
        await remove();
        await put();
        return true;
      } catch (err) {
        // Unknown is not acquired: skip this invocation.
        console.error(
          JSON.stringify({
            event: 'relay:lease-unavailable',
            error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
          }),
        );
        return false;
      }
    },

    async release() {
      try {
        const { record } = await read();
        if (record?.invocationId !== invocationId) return;
        await remove();
      } catch {
        // The lease expires on its own.
      }
    },
  };
}

interface LeaseContext {
  awsRequestId?: string;
  getRemainingTimeInMillis?: () => number;
}

/**
 * Runs the relay invocation only while holding the lease. Without an
 * installation id the invocation runs unguarded so it can report its own
 * missing configuration.
 */
export function withLease<E, C extends object>(
  run: (event: E, context?: C) => Promise<void>,
  makeClient: () => SendsCommands = () => new SSMClient({}),
): (event: E, context?: C) => Promise<void> {
  return async (event, context) => {
    const lambda = context as LeaseContext | undefined;
    const installationId = process.env['DEPLOYZ_INSTALLATION_ID'];
    if (!installationId) return run(event, context);
    const lease = createLease({
      client: makeClient(),
      parameterName: leaseParameterName(installationId),
      invocationId: lambda?.awsRequestId ?? `local-${Date.now()}`,
      ...(lambda?.getRemainingTimeInMillis
        ? { runMs: lambda.getRemainingTimeInMillis() }
        : {}),
    });
    if (!(await lease.acquire())) {
      console.log(JSON.stringify({ event: 'relay:lease-held', installationId }));
      return;
    }
    try {
      await run(event, context);
    } finally {
      await lease.release();
    }
  };
}

/**
 * Guaranteed teardown — a cleanup registry plus a finally-block wrapper.
 *
 * The integration suite must never leave resources behind in the test account,
 * even when the run fails mid-flight. Two primitives guarantee this:
 *
 *   1. `CleanupRegistry` — tracks every resource created during a run, keyed by
 *      type + id, with an async cleanup function for each. `teardown()` runs
 *      the cleanups in REVERSE creation order (dependencies are torn down
 *      before their dependents), best-effort (one failing cleanup does not stop
 *      the rest), and records what happened for the runner to report.
 *
 *   2. `runWithTeardown(fn)` — runs the test and ALWAYS calls `teardown()` in a
 *      `finally` block. Whether `fn` returns or throws, teardown runs.
 *
 * Pure TypeScript — no AWS, fully unit-testable.
 */

/** An async resource cleanup (e.g. `() => cfn.deleteStack({...})`). */
export type CleanupFn = () => Promise<void>;

/** One registered resource to clean up. */
export interface CleanupEntry {
  /** Resource type, e.g. `cloudformation-stack`. */
  readonly resourceType: string;
  /** Resource identifier, e.g. the stack name. */
  readonly resourceId: string;
  readonly cleanup: CleanupFn;
}

/** A single failed cleanup, captured rather than thrown. */
export interface CleanupError {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly message: string;
}

/** What `teardown()` did, so the runner can report it. */
export interface TeardownResult {
  /** Number of resources teardown attempted to clean up. */
  readonly attempted: number;
  /** Number that cleaned up without throwing. */
  readonly succeeded: number;
  /** Number that threw during cleanup. */
  readonly failed: number;
  /** Failures, in the order they were encountered. */
  readonly errors: readonly CleanupError[];
  /** Resource ids in the order teardown ran them (reverse creation order). */
  readonly order: readonly string[];
}

/** Best-effort message extraction from an unknown thrown value. */
function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class CleanupRegistry {
  private readonly entries: CleanupEntry[] = [];
  private _lastResult: TeardownResult | undefined;

  /** Registers a resource for cleanup (creation order is preserved). */
  register(resourceType: string, resourceId: string, cleanup: CleanupFn): void {
    this.entries.push({ resourceType, resourceId, cleanup });
  }

  /** Number of resources currently pending cleanup. */
  get size(): number {
    return this.entries.length;
  }

  /** Snapshot of the pending entries (creation order). */
  get pending(): readonly CleanupEntry[] {
    return [...this.entries];
  }

  /** The result of the most recent `teardown()` call, if any. */
  get lastResult(): TeardownResult | undefined {
    return this._lastResult;
  }

  /**
   * Runs all registered cleanups in REVERSE creation order.
   *
   * Best-effort: a throwing cleanup is recorded and teardown continues with
   * the remaining resources. Returns a summary; does NOT throw.
   */
  async teardown(): Promise<TeardownResult> {
    const entries = [...this.entries].reverse();
    const order: string[] = [];
    const errors: CleanupError[] = [];

    for (const entry of entries) {
      order.push(entry.resourceId);
      try {
        await entry.cleanup();
      } catch (error) {
        errors.push({
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          message: toMessage(error),
        });
      }
    }

    this.entries.length = 0;

    const result: TeardownResult = {
      attempted: entries.length,
      succeeded: entries.length - errors.length,
      failed: errors.length,
      errors,
      order,
    };
    this._lastResult = result;
    return result;
  }
}

/**
 * Runs `fn`, ALWAYS running the registry's teardown in a `finally` block.
 *
 * If `fn` throws, teardown still runs and the original error is re-thrown
 * (teardown failures are captured in `registry.lastResult`, never allowed to
 * mask the test error). The caller owns the registry so it can inspect
 * `lastResult` after a failure.
 */
export async function runWithTeardown<T>(
  registry: CleanupRegistry,
  fn: (registry: CleanupRegistry) => Promise<T>,
): Promise<T> {
  try {
    return await fn(registry);
  } finally {
    await registry.teardown();
  }
}

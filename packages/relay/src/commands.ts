/**
 * Relay command vocabulary — the fixed set of commands the relay can execute.
 *
 * The relay is a fixed-vocabulary actor, not a general-purpose agent. It
 * understands exactly six command types (§39). Every command carries an
 * idempotency key; re-delivery of the same key produces the same result with
 * no side effects.
 *
 * Unknown commands are rejected with an event logged, no side effects.
 */

// ── Command vocabulary (§39) ────────────────────────────────────────────────

/** The six command types the relay understands. */
export const RELAY_COMMAND_TYPES = [
  'INSTALL',
  'REPORT_HEALTH',
  'DEPLOY_RELEASE',
  'ROLLBACK',
  'CONFIG_UPDATE',
  'DESTROY',
] as const;

export type RelayCommandType = (typeof RELAY_COMMAND_TYPES)[number];

/** A command dispatched to the relay from the control plane. */
export interface RelayCommand {
  /** UUID of the deployment job (matches DeploymentJob.id). */
  readonly id: string;
  /** UUID of the deployment this command targets. */
  readonly deploymentId: string;
  /** The command type — must be one of the six known types. */
  readonly type: RelayCommandType;
  /** §39 idempotency key — retries with the same key must not double-execute. */
  readonly idempotencyKey: string;
  /** Command-specific payload (shape varies by type). */
  readonly payload: Record<string, unknown>;
}

/** Result of executing a relay command. */
export interface RelayCommandResult {
  /** The command id this result corresponds to. */
  readonly commandId: string;
  /** The idempotency key from the command. */
  readonly idempotencyKey: string;
  /** Whether execution succeeded. */
  readonly success: boolean;
  /** Command-specific output (set on success). */
  readonly output?: Record<string, unknown>;
  /** Human-readable error message (set on failure). */
  readonly error?: string;
}

// ── Idempotency (§39) ───────────────────────────────────────────────────────

/**
 * In-memory idempotency store. Tracks executed idempotency keys so re-delivery
 * of the same key returns the cached result with no re-execution.
 *
 * In production this would be DynamoDB-backed for cross-invocation persistence;
 * the in-memory Map is sufficient for the relay logic layer (todo 12 scope).
 */
export class IdempotencyStore {
  readonly #results = new Map<string, RelayCommandResult>();

  /** Check whether a key has already been executed. */
  has(key: string): boolean {
    return this.#results.has(key);
  }

  /** Retrieve the cached result for a previously-executed key. */
  get(key: string): RelayCommandResult | undefined {
    return this.#results.get(key);
  }

  /** Store a result keyed by its idempotency key. */
  set(key: string, result: RelayCommandResult): void {
    this.#results.set(key, result);
  }

  /** Number of tracked keys (for testing). */
  get size(): number {
    return this.#results.size;
  }
}

// ── Command dispatch ─────────────────────────────────────────────────────────

/**
 * A command executor is a function that takes a command and returns a result.
 * Each command type has its own executor registered in the dispatch table.
 */
export type CommandExecutor = (command: RelayCommand) => Promise<RelayCommandResult>;

/**
 * Dispatch a command to its registered executor.
 *
 * Returns the cached result if the idempotency key has already been seen.
 * Unknown command types are rejected with an error result (no side effects).
 */
export async function dispatchCommand(
  command: RelayCommand,
  executors: Readonly<Record<RelayCommandType, CommandExecutor>>,
  idempotency: IdempotencyStore,
): Promise<RelayCommandResult> {
  // Idempotency check — return cached result for re-delivered keys.
  if (idempotency.has(command.idempotencyKey)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- has() guarantees presence
    return idempotency.get(command.idempotencyKey)!;
  }

  // Validate command type.
  if (!isKnownCommandType(command.type)) {
    const result: RelayCommandResult = {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      error: `Unknown command type: ${command.type}`,
    };
    idempotency.set(command.idempotencyKey, result);
    return result;
  }

  // Dispatch to the registered executor.
  const executor = executors[command.type];
  const result = await executor(command);
  idempotency.set(command.idempotencyKey, result);
  return result;
}

/** Type guard: is this string one of the six known command types? */
export function isKnownCommandType(value: string): value is RelayCommandType {
  return (RELAY_COMMAND_TYPES as readonly string[]).includes(value);
}
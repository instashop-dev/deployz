/**
 * U1 Durable Function spike — core runtime.
 *
 * Implements a lightweight durable execution framework on AWS Lambda.
 * Workflows are defined as async generator functions that yield step
 * descriptors; the runtime executes steps one at a time, persisting
 * state to a pluggable store between each step.
 *
 * Key primitives:
 * - step(name, fn)     — execute a named step, record result in history
 * - waitForCallback(t)  — suspend until an external HTTPS callback with token t
 * - wait(ms)            — suspend for a timed duration
 *
 * External resumption: call runtime.resume(executionId, callbackData)
 * to wake a workflow suspended on waitForCallback.
 *
 * This is a PATTERN implementation — not a native AWS service. The
 * decision record (.omo/evidence/decision-record-u1.md) compares this
 * custom approach against the Step Functions fallback.
 */

// ── Types ────────────────────────────────────────────────────────────────

/** A single step descriptor yielded by a workflow generator. */
export type WorkflowStep =
  | { readonly type: 'step'; readonly name: string; readonly fn: () => Promise<unknown> }
  | { readonly type: 'waitForCallback'; readonly token: string; readonly timeoutMs: number }
  | { readonly type: 'wait'; readonly durationMs: number };

/**
 * §28/§59 default deadline for a suspended `waitForCallback`. A relay whose
 * result never arrives (bootstrap died mid-flight, customer account went
 * dark, etc.) must not leave the execution RUNNING forever — 24h is a
 * generous ceiling for any single relay round-trip (install, deploy,
 * rollback, config, destroy confirmation).
 */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Persistent state for a workflow execution. */
export interface WorkflowState {
  readonly executionId: string;
  status: 'RUNNING' | 'WAITING_CALLBACK' | 'WAITING_TIMER' | 'COMPLETED' | 'FAILED';
  currentStep: number;
  totalYields: number;
  history: WorkflowHistoryEntry[];
  callbackToken?: string;
  /** ISO-8601 deadline for the current `waitForCallback` suspension (§28/§59). */
  callbackDeadline?: string;
  /**
   * DynamoDB TTL attribute (epoch seconds) — matches `timeToLiveAttribute:
   * 'ttl'` on the WorkflowState table (durable-stack.ts). Set whenever the
   * execution suspends on `waitForCallback` so a stale row auto-expires
   * instead of lingering indefinitely; `expireStaleExecutions` transitions
   * still-RUNNING rows to FAILED before that natural expiry.
   */
  ttl?: number;
  resumeAt?: string;
  input: unknown;
  output?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowHistoryEntry {
  step: number;
  name: string;
  result?: unknown;
  timestamp: string;
}

/** Pluggable state store — in-memory for tests, DynamoDB for production. */
export interface StateStore {
  get(executionId: string): Promise<WorkflowState | null>;
  put(state: WorkflowState): Promise<void>;
  delete(executionId: string): Promise<void>;
}

/** A durable workflow is an async generator yielding WorkflowSteps. */
export type DurableWorkflow<TInput = unknown, TOutput = unknown> = (
  input: TInput,
) => AsyncGenerator<WorkflowStep, TOutput, unknown>;

// ── Runtime ──────────────────────────────────────────────────────────────

export class DurableRuntime {
  constructor(private readonly store: StateStore) {}

  /**
   * Execute a workflow from the beginning.
   * Returns the executionId immediately; the workflow runs step-by-step
   * across multiple Lambda invocations.
   */
  async start<TInput>(
    workflow: DurableWorkflow<TInput>,
    input: TInput,
    executionId: string,
  ): Promise<WorkflowState> {
    const state: WorkflowState = {
      executionId,
      status: 'RUNNING',
      currentStep: 0,
      totalYields: 0,
      history: [],
      input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(state);
    return this.advance(workflow, state);
  }

  /**
   * Resume a suspended workflow. Called when:
   * - An external callback arrives (waitForCallback resumption)
   * - A timer fires (wait resumption)
   */
  async resume<TInput>(
    workflow: DurableWorkflow<TInput>,
    executionId: string,
    callbackData?: unknown,
  ): Promise<WorkflowState> {
    const state = await this.store.get(executionId);
    if (!state) {
      throw new Error(`Workflow ${executionId} not found`);
    }
    if (state.status === 'COMPLETED' || state.status === 'FAILED') {
      return state;
    }

    let result = await this.advance(workflow, state, callbackData);

    while (result.status === 'WAITING_TIMER') {
      result = await this.advance(workflow, result, true);
    }

    return result;
  }

  /**
   * §28/§59: transition a single execution to FAILED if it is WAITING_CALLBACK
   * and past its `callbackDeadline` — a relay result that never arrives must
   * not leave the row RUNNING forever. Returns true when the execution was
   * expired, false when it was not eligible (missing, not WAITING_CALLBACK,
   * or not yet past its deadline).
   *
   * This does NOT invoke the workflow generator — an expired execution is
   * terminal (FAILED), so there is nothing left to replay.
   */
  async expireIfStale(
    executionId: string,
    now: () => Date = () => new Date(),
  ): Promise<boolean> {
    const state = await this.store.get(executionId);
    if (!state || state.status !== 'WAITING_CALLBACK' || !state.callbackDeadline) {
      return false;
    }
    if (now().getTime() < new Date(state.callbackDeadline).getTime()) {
      return false;
    }

    state.status = 'FAILED';
    state.error = `Execution expired: no callback received before deadline ${state.callbackDeadline} (token=${state.callbackToken ?? 'unknown'})`;
    state.updatedAt = now().toISOString();
    await this.store.put(state);
    return true;
  }

  /**
   * Sweep a batch of candidate execution ids, expiring any past their
   * WAITING_CALLBACK deadline (§28/§59). This is the entry point a scheduled
   * caller invokes; it does not itself discover candidates — `StateStore` is
   * a pure key-value store keyed by executionId with no query-by-status
   * capability. A real scheduler would list candidates via a DynamoDB GSI (or
   * rely on the table's `ttl` attribute for eventual natural cleanup) and
   * pass the ids here. Returns the ids that were actually expired.
   */
  async expireStaleExecutions(
    executionIds: readonly string[],
    now: () => Date = () => new Date(),
  ): Promise<readonly string[]> {
    const expired: string[] = [];
    for (const executionId of executionIds) {
      if (await this.expireIfStale(executionId, now)) {
        expired.push(executionId);
      }
    }
    return expired;
  }

  /**
   * Advance a workflow by executing steps until it suspends or completes.
   *
   * Uses a stepIndex counter to track replay position. Steps before
   * state.currentStep are replayed (their recorded results are fed back
   * to the generator). When resumeValue is provided, the suspension step
   * is skipped by injecting resumeValue as the yield result.
   */
  private async advance<TInput>(
    workflow: DurableWorkflow<TInput>,
    state: WorkflowState,
    resumeValue?: unknown,
  ): Promise<WorkflowState> {
    const gen = workflow(state.input as TInput);
    let nextInput: unknown = undefined;
    let yieldIndex = 0;
    let historyIndex = 0;

    while (true) {
      const result = await gen.next(nextInput);

      if (result.done) {
        state.status = 'COMPLETED';
        state.output = result.value;
        state.updatedAt = new Date().toISOString();
        await this.store.put(state);
        return state;
      }

      const step = result.value;

      if (yieldIndex < state.totalYields) {
        if (step.type === 'step') {
          nextInput = state.history[historyIndex]?.result;
          historyIndex++;
        }
        yieldIndex++;
        continue;
      }

      if (resumeValue !== undefined) {
        nextInput = resumeValue;
        resumeValue = undefined;
        yieldIndex++;
        state.totalYields = yieldIndex;
        continue;
      }

      switch (step.type) {
        case 'step': {
          const stepResult = await step.fn();
          state.history.push({
            step: state.currentStep,
            name: step.name,
            result: stepResult,
            timestamp: new Date().toISOString(),
          });
          state.currentStep++;
          nextInput = stepResult;
          yieldIndex++;
          state.totalYields = yieldIndex;
          break;
        }

        case 'waitForCallback': {
          const now = Date.now();
          state.status = 'WAITING_CALLBACK';
          state.callbackToken = step.token;
          state.callbackDeadline = new Date(now + step.timeoutMs).toISOString();
          state.ttl = Math.floor((now + step.timeoutMs) / 1000);
          state.updatedAt = new Date().toISOString();
          state.totalYields = yieldIndex;
          await this.store.put(state);
          return state;
        }

        case 'wait': {
          state.status = 'WAITING_TIMER';
          state.resumeAt = new Date(
            Date.now() + step.durationMs,
          ).toISOString();
          state.updatedAt = new Date().toISOString();
          state.totalYields = yieldIndex;
          await this.store.put(state);
          return state;
        }
      }
    }
  }
}

// ── In-memory store (for tests) ──────────────────────────────────────────

export class InMemoryStateStore implements StateStore {
  private readonly store = new Map<string, WorkflowState>();

  async get(executionId: string): Promise<WorkflowState | null> {
    return this.store.get(executionId) ?? null;
  }

  async put(state: WorkflowState): Promise<void> {
    this.store.set(state.executionId, { ...state });
  }

  async delete(executionId: string): Promise<void> {
    this.store.delete(executionId);
  }
}

// ── Helper: create a step descriptor ─────────────────────────────────────

export function step(name: string, fn: () => Promise<unknown>): WorkflowStep {
  return { type: 'step', name, fn };
}

export function waitForCallback(
  token: string,
  timeoutMs: number = DEFAULT_CALLBACK_TIMEOUT_MS,
): WorkflowStep {
  return { type: 'waitForCallback', token, timeoutMs };
}

export function wait(durationMs: number): WorkflowStep {
  return { type: 'wait', durationMs };
}
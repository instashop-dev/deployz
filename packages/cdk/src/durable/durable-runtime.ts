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
  | { readonly type: 'waitForCallback'; readonly token: string }
  | { readonly type: 'wait'; readonly durationMs: number };

/** Persistent state for a workflow execution. */
export interface WorkflowState {
  readonly executionId: string;
  status: 'RUNNING' | 'WAITING_CALLBACK' | 'WAITING_TIMER' | 'COMPLETED' | 'FAILED';
  currentStep: number;
  totalYields: number;
  history: WorkflowHistoryEntry[];
  callbackToken?: string;
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
          state.status = 'WAITING_CALLBACK';
          state.callbackToken = step.token;
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

export function waitForCallback(token: string): WorkflowStep {
  return { type: 'waitForCallback', token };
}

export function wait(durationMs: number): WorkflowStep {
  return { type: 'wait', durationMs };
}
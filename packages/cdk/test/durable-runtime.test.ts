import { describe, it, expect, beforeEach } from 'vitest';
import {
  DurableRuntime,
  InMemoryStateStore,
  step,
  wait,
  waitForCallback,
  type DurableWorkflow,
  type WorkflowState,
} from '../src/durable/durable-runtime.js';

// ── Test workflow ────────────────────────────────────────────────────────

interface TestInput {
  name: string;
  value: number;
}

interface TestOutput {
  result: string;
  steps: number;
}

/**
 * A test workflow that exercises all three primitives:
 * 1. step: double the input value
 * 2. waitForCallback: wait for external confirmation
 * 3. step: finalize
 * 4. wait: brief pause
 * 5. step: return result
 */
async function* testWorkflow(
  input: TestInput,
): AsyncGenerator<
  ReturnType<typeof step> | ReturnType<typeof waitForCallback> | ReturnType<typeof wait>,
  TestOutput,
  unknown
> {
  // Step 1: Process input
  const doubled = yield step('double-value', async () => {
    return input.value * 2;
  });

  // Step 2: Wait for external callback
  const callbackResult = yield waitForCallback('confirm');

  // Step 3: Finalize with callback data
  const finalized = yield step('finalize', async () => {
    const confirmedBy =
      (callbackResult as Record<string, unknown> | undefined)?.['user'] ?? 'unknown';
    return `${input.name}-${doubled}-${confirmedBy}`;
  });

  // Step 4: Brief wait
  yield wait(10);

  // Step 5: Return
  yield step('count-steps', async () => 5);

  return {
    result: String(finalized),
    steps: 5,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('DurableRuntime', () => {
  let store: InMemoryStateStore;
  let runtime: DurableRuntime;

  beforeEach(() => {
    store = new InMemoryStateStore();
    runtime = new DurableRuntime(store);
  });

  describe('step()', () => {
    it('executes a step and records it in history', async () => {
      const state = await runtime.start(
        testWorkflow,
        { name: 'test', value: 21 },
        'exec-1',
      );

      // Should have executed step 1 (double-value) then suspended on
      // waitForCallback.
      expect(state.status).toBe('WAITING_CALLBACK');
      expect(state.currentStep).toBe(1);
      expect(state.history).toHaveLength(1);
      expect(state.history[0]?.name).toBe('double-value');
      expect(state.history[0]?.result).toBe(42);
    });

    it('persists state between invocations', async () => {
      await runtime.start(testWorkflow, { name: 'test', value: 10 }, 'exec-2');

      const stored = await store.get('exec-2');
      expect(stored).not.toBeNull();
      expect(stored?.status).toBe('WAITING_CALLBACK');
      expect(stored?.history).toHaveLength(1);
    });
  });

  describe('waitForCallback()', () => {
    it('suspends workflow and records callback token', async () => {
      const state = await runtime.start(
        testWorkflow,
        { name: 'test', value: 5 },
        'exec-3',
      );

      expect(state.status).toBe('WAITING_CALLBACK');
      expect(state.callbackToken).toBe('confirm');
    });

    it('resumes when callback data is provided', async () => {
      // Start → suspends on waitForCallback
      await runtime.start(testWorkflow, { name: 'test', value: 5 }, 'exec-4');

      // Resume with callback data
      const state = await runtime.resume(
        testWorkflow,
        'exec-4',
        { user: 'alice' },
      );

      // Should have completed all remaining steps
      expect(state.status).toBe('COMPLETED');
      expect(state.output).toEqual({
        result: 'test-10-alice',
        steps: 5,
      });
      expect(state.history).toHaveLength(3); // double-value, finalize, count-steps
    });

    it('is idempotent on re-resume of completed workflow', async () => {
      await runtime.start(testWorkflow, { name: 'test', value: 5 }, 'exec-5');
      const first = await runtime.resume(
        testWorkflow,
        'exec-5',
        { user: 'alice' },
      );

      // Re-resume should return same completed state
      const second = await runtime.resume(
        testWorkflow,
        'exec-5',
        { user: 'bob' },
      );

      expect(second.status).toBe('COMPLETED');
      expect(second).toEqual(first);
    });
  });

  describe('wait()', () => {
    it('suspends workflow with a resumeAt timestamp', async () => {
      // Create a workflow that only does wait()
      async function* waitOnlyWorkflow(): AsyncGenerator<
        ReturnType<typeof wait>,
        string,
        unknown
      > {
        yield wait(5000);
        return 'done';
      }

      const state = await runtime.start(waitOnlyWorkflow, undefined, 'exec-6');

      expect(state.status).toBe('WAITING_TIMER');
      expect(state.resumeAt).toBeDefined();
      // resumeAt should be ~5 seconds in the future
      const resumeAt = new Date(state.resumeAt!).getTime();
      const now = Date.now();
      expect(resumeAt).toBeGreaterThan(now);
      expect(resumeAt - now).toBeLessThan(6000); // Allow some slack
    });

    it('resumes after wait by direct invocation', async () => {
      async function* waitThenDone(): AsyncGenerator<
        ReturnType<typeof wait>,
        string,
        unknown
      > {
        yield wait(1); // 1ms — effectively immediate
        return 'resumed';
      }

      await runtime.start(waitThenDone, undefined, 'exec-7');
      const state = await runtime.resume(waitThenDone, 'exec-7');

      expect(state.status).toBe('COMPLETED');
      expect(state.output).toBe('resumed');
    });
  });

  describe('full workflow execution', () => {
    it('completes a workflow end-to-end with external resumption', async () => {
      // Start the workflow
      const suspended = await runtime.start(
        testWorkflow,
        { name: 'e2e', value: 100 },
        'exec-e2e',
      );

      expect(suspended.status).toBe('WAITING_CALLBACK');
      expect(suspended.callbackToken).toBe('confirm');

      // Simulate external callback (the "relay first contact" pattern)
      const completed = await runtime.resume(
        testWorkflow,
        'exec-e2e',
        { user: 'relay-lambda', confirmedBy: 'customer-click' },
      );

      expect(completed.status).toBe('COMPLETED');
      expect(completed.output).toEqual({
        result: 'e2e-200-relay-lambda',
        steps: 5,
      });
      expect(completed.history).toHaveLength(3);
    });
  });

  describe('error handling', () => {
    it('throws when resuming a non-existent workflow', async () => {
      await expect(
        runtime.resume(testWorkflow, 'nonexistent'),
      ).rejects.toThrow('Workflow nonexistent not found');
    });

    it('throws when a step function throws', async () => {
      async function* failingWorkflow(): AsyncGenerator<
        ReturnType<typeof step>,
        string,
        unknown
      > {
        yield step('will-fail', async () => {
          throw new Error('step failed');
        });
        return 'never';
      }

      await expect(
        runtime.start(failingWorkflow, undefined, 'exec-fail'),
      ).rejects.toThrow('step failed');
    });
  });

  describe('InMemoryStateStore', () => {
    it('stores and retrieves state', async () => {
      await store.put({
        executionId: 'test-1',
        status: 'RUNNING',
        currentStep: 0,
        totalYields: 0,
        history: [],
        input: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const retrieved = await store.get('test-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.executionId).toBe('test-1');
    });

    it('returns null for missing state', async () => {
      const retrieved = await store.get('missing');
      expect(retrieved).toBeNull();
    });

    it('deletes state', async () => {
      await store.put({
        executionId: 'test-del',
        status: 'RUNNING',
        currentStep: 0,
        totalYields: 0,
        history: [],
        input: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await store.delete('test-del');
      const retrieved = await store.get('test-del');
      expect(retrieved).toBeNull();
    });
  });
});
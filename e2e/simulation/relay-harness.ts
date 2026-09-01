/**
 * Simulated relay harness — runs the REAL relay code (`pollOnce`, the real
 * INSTALL executor, real `verifyInstallation`, real provisioning-snapshot and
 * stack-event collection, real runtime-health observation) inside the
 * Playwright test process, speaking the real relay HTTP protocol
 * (register/commands/result/progress/health) to the real local API — see
 * docs/testing/discovery/phase1-design-decisions.md D1.
 *
 * Only the AWS *client* interfaces are replaced, by a `SimulatedCustomerAccount`
 * driven by a `ScenarioDefinition`. Composition below mirrors how
 * `createRelayHandler` (packages/relay/src/index.ts) builds `InstallExecutorDeps`
 * and the observe hook in `createDefaultInstallDeps`/`relayHandler` — reusing
 * the relay's own exported composition helpers (`createInstallExecutor`,
 * `createObserveHook`, `verifyInstallation`, `buildProvisioningSnapshot`,
 * `listAllStackResources`, `observeRuntimeHealth`, `installApplicationStack`,
 * `createStackEventCollector`, `pollOnce`) rather than reimplementing them.
 *
 * Two differences from production wiring, both required for injection:
 *  - no lazy real-AWS-SDK singletons (`getCloudFormationReader()` etc.) — the
 *    simulated account's adapters are passed directly;
 *  - only the INSTALL executor is wired (Phase 1 scope; DEPLOY_RELEASE/
 *    ROLLBACK/RESTART/DESTROY/etc. are left for a later phase, per the task).
 */

import { createInstallExecutor, createObserveHook, type InstallExecutorDeps } from '@deployz/relay';
import { buildAuthHeaders, createAuthState, type AuthState, type FetchFn } from '@deployz/relay/auth';
import { type CommandExecutor, IdempotencyStore } from '@deployz/relay/commands';
import { observeRuntimeHealth } from '@deployz/relay/ecs-health';
import { installApplicationStack } from '@deployz/relay/install';
import { memoryPendingStore } from '@deployz/relay/pending';
import { pollOnce, reportCommandProgress, type PollDependencies } from '@deployz/relay/poll';
import { buildProvisioningSnapshot } from '@deployz/relay/provision-progress';
import { listAllStackResources } from '@deployz/relay/stack-resources';
import { createStackEventCollector } from '@deployz/relay/stack-events';
import { verifyInstallation } from '@deployz/relay/verify';
import { APPLICATION_TEMPLATE_KEY, DEFAULT_APPLICATION_STACK_NAME } from '@deployz/contracts';

import { SimulatedCustomerAccount } from './simulated-account.js';
import type { ScenarioDefinition } from './types.js';

export interface StartSimulatedRelayOptions {
  readonly scenario: ScenarioDefinition;
  /** Base URL of the real local API (e.g. `http://localhost:3001`). */
  readonly apiUrl: string;
  readonly installationId: string;
  readonly enrollmentCode: string;
  /** The relay's bearer token — mirrors e2e/deployment-progress.spec.ts's
   *  `Authorization: Bearer <token>` convention (any unique string works;
   *  the control plane binds whatever token first registers). */
  readonly relayToken: string;
  /** Real `fetch` by default — the harness speaks the real HTTP protocol. */
  readonly fetchFn?: FetchFn;
  /** Real milliseconds between poll cycles — stands in for the 5-minute
   *  EventBridge schedule, sped way up. Defaults to 100ms. */
  readonly pollTickMs?: number;
  /**
   * Additive knob for the relay-disconnect scenario
   * (./scenarios/relay-disconnect.ts): once the stack-event collector's
   * `report` callback has been called once with a non-empty batch (i.e. the
   * relay has genuinely reported some progress), every subsequent call —
   * including the one that would eventually report the INSTALL job's
   * result — hangs forever instead of completing. This mirrors a relay
   * Lambda whose network died mid-invocation: `installApplicationStack`'s
   * wait loop (packages/relay/src/install.ts) awaits `onPoll` with no
   * timeout, so the whole in-flight `pollOnce()` call simply never resolves,
   * and — because the poll harness below only schedules its next tick after
   * the previous one resolves — no further poll cycle ever runs either.
   * Never resolves/rejects by design; safe because nothing in this harness
   * ever awaits that hung promise except the one poll cycle it belongs to.
   */
  readonly stopAfterFirstProgress?: boolean;
}

export interface InstallSettlement {
  readonly succeeded: boolean;
}

export interface SimulatedRelayHandle {
  readonly account: SimulatedCustomerAccount;
  /** Stops the poll-cycle timer. Safe to call more than once. */
  stop(): void;
  /** Resolves once a poll cycle has reported a non-deferred INSTALL result. */
  waitForResult(): Promise<InstallSettlement>;
}

export function startSimulatedRelay(options: StartSimulatedRelayOptions): SimulatedRelayHandle {
  const { scenario, apiUrl, installationId, enrollmentCode, relayToken } = options;
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const pollTickMs = options.pollTickMs ?? 100;

  const account = new SimulatedCustomerAccount(scenario);
  const authState: AuthState = createAuthState(installationId, relayToken);
  const idempotency = new IdempotencyStore();

  // Refreshed every poll from GET /api/relay/commands' `deployment` meta —
  // same role as `deploymentMeta` in packages/relay/src/index.ts.
  let redisRequired = false;

  const stackNameOrDefault = (): string => account.stackName ?? DEFAULT_APPLICATION_STACK_NAME;

  // See `stopAfterFirstProgress` doc comment above.
  let hasReportedProgress = false;
  let silenced = false;

  const installDeps: InstallExecutorDeps = {
    installationId,
    // Never resolved for real — only its shape (ending in the published
    // application-template key) matters, so `redisApplicationTemplateUrl`
    // can locate the Redis variant when a scenario ever requires one.
    templateUrl: `https://simulated-templates.deployz.test/application/v1/${APPLICATION_TEMPLATE_KEY}`,
    // The collector's `operationStartedAt` boundary and the pending marker's
    // `startedAt` — both read off the account's own virtual clock so every
    // event this scenario ever reveals timestamps at or after it.
    now: () => account.operationStartedAtIso(),
    install: (request) =>
      installApplicationStack({
        ...request,
        installer: account.stackInstaller(),
        // Fast wait-loop tick, generous budget — installs settle inside one
        // invocation for every scenario this harness plays today.
        pollIntervalMs: 25,
        budgetMs: 30_000,
      }),
    verify: (request) => verifyInstallation({ ...request, cfn: account.cloudFormationReader() }),
    pending: memoryPendingStore(),
    createStackEventCollector: ({ commandId, operationStartedAt, stackName, resumeAfter }) =>
      createStackEventCollector({
        reader: account.stackEventsReader(),
        report: (events) => {
          if (silenced) {
            // Gone silent — never resolves. See `stopAfterFirstProgress`.
            return new Promise<boolean>(() => {});
          }
          const reported = reportCommandProgress(fetchFn, apiUrl, buildAuthHeaders(authState), {
            commandId,
            installationId,
            stackName,
            events: [...events],
          });
          if (options.stopAfterFirstProgress && !hasReportedProgress) {
            hasReportedProgress = true;
            silenced = true;
          }
          return reported;
        },
        operationStartedAt,
        ...(resumeAfter !== undefined ? { resumeAfter } : {}),
      }),
  };

  let settlement: InstallSettlement | null = null;
  let waiters: Array<(result: InstallSettlement) => void> = [];

  const baseInstallExecutor = createInstallExecutor(installDeps);
  const installExecutor: CommandExecutor = async (command) => {
    const result = await baseInstallExecutor(command);
    if (!result.deferred && settlement === null) {
      settlement = { succeeded: result.success };
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) waiter(settlement);
    }
    return result;
  };

  const pollDeps: PollDependencies = {
    fetchFn,
    controlPlaneUrl: apiUrl,
    installationId,
    enrollmentCode,
    executors: { INSTALL: installExecutor },
    idempotency,
    // Mirrors createRelayHandler's default observe hook, over the simulated
    // reader instead of the real CloudFormationReader singleton.
    observe: createObserveHook(
      () =>
        verifyInstallation({
          cfn: account.cloudFormationReader(),
          installationId,
          stackName: stackNameOrDefault(),
          ...(redisRequired ? { redisRequired: true } : {}),
        }),
      () => buildProvisioningSnapshot(account.cloudFormationReader(), stackNameOrDefault()),
      () =>
        listAllStackResources(account.cloudFormationReader(), stackNameOrDefault()).then((inventory) =>
          inventory ? { ...inventory, observedAt: new Date().toISOString() } : null,
        ),
    ),
    observeHealth: () =>
      observeRuntimeHealth(
        {
          cfn: account.cloudFormationReader(),
          ecs: account.ecsServiceReader(),
          elb: account.targetHealthReader(),
        },
        stackNameOrDefault(),
      ),
    onDeploymentMeta: (meta) => {
      redisRequired = meta.redisRequired;
    },
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await pollOnce(pollDeps, authState);
    } catch {
      // Best-effort, same as a real relay invocation — the next tick retries.
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), pollTickMs);
    }
  }

  void tick();

  return {
    account,
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    waitForResult(): Promise<InstallSettlement> {
      if (settlement !== null) return Promise.resolve(settlement);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

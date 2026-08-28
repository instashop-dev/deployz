/**
 * Relay Lambda handler — the outbound actor in the customer's AWS account.
 *
 * Invoked by EventBridge on a fixed 5-minute schedule (defined in the
 * bootstrap stack, todo 8). On each invocation:
 *
 *   1. Reads the bootstrap-generated credential from Secrets Manager
 *   2. Creates/restores the auth state
 *   3. Polls the control plane for pending commands
 *   4. Executes each command (with idempotency)
 *   5. Reports results + observed state back to the control plane (§59)
 *
 * The relay is EGRESS-ONLY: it calls OUT to the control plane; the control
 * plane never reaches INTO the customer account.
 *
 * §16 data boundary: the relay writes operational logs but deliberately
 * CANNOT read them back (no `logs:GetLogEvents` / `logs:FilterLogEvents`).
 * This is enforced at IAM in the bootstrap stack, not in code.
 */

import type { ScheduledEvent } from 'aws-lambda';

import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  type RegisterTaskDefinitionCommandInput,
} from '@aws-sdk/client-ecs';
import {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { GetSecretValueCommand, SecretsManagerClient as AwsSecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createAuthState, readCredential, type FetchFn, type SecretsClient } from './auth.js';
import {
  IdempotencyStore,
  type CommandExecutor,
  type RelayCommand,
  type RelayCommandResult,
} from './commands.js';
import { createDomainExecutors, createRealDomainAwsClients } from './domain.js';
import {
  createEcsDeployExecutor,
  createEcsDeployResumer,
  createRestartExecutor,
  type EcsDeployClient,
  type EcsDeployDeps,
} from './deploy.js';
import { observeRunningImageDigest, type EcsTaskReader } from './ecs-observe.js';
import { observeRuntimeHealth, type EcsServiceReader, type TargetHealthReader } from './ecs-health.js';
import { readRelayIdentity } from './identity.js';
import {
  createStackInstaller,
  installApplicationStack,
  type InstallOptions,
  type InstallOutcome,
  type StackInstaller,
} from './install.js';
import {
  createPendingStore,
  memoryPendingStore,
  pendingParameterName,
  type PendingStore,
} from './pending.js';
import { pollOnce, type PollDependencies } from './poll.js';
import {
  createRealCacheCleanupClient,
  createRealRdsCleanupClient,
  createRecoveryCloudFormation,
  recoverFailedInstallStack,
  type CacheCleanupClient,
  type RecoveryCloudFormation,
  type RecoveryReport,
  type RdsCleanupClient,
} from './recover.js';
import {
  createCloudFormationReader,
  verifyInstallation,
  type CloudFormationReader,
  type VerificationResult,
  type VerifyOptions,
} from './verify.js';
import { DEFAULT_APPLICATION_STACK_NAME as DEFAULT_STACK_NAME } from '@deployz/contracts';

// ── Lazy SDK singleton ───────────────────────────────────────────────────────
//
// The CloudFormation reader wraps a real SDK client (full config +
// credential-chain resolution). Following the same lazy-singleton idiom as
// `getAcmSdkClient()` / `getElbSdkClient()` in `./domain.js`, it is
// constructed on first use, not at module load — so importing this module
// never touches AWS, and unit tests that never trigger the INSTALL executor
// or the `observe` hook construct nothing. This matters more here than for
// INSTALL alone: `observe` runs on every poll, once every 5 minutes, forever,
// whereas INSTALL runs at most once or twice per container's lifetime.

let cloudFormationReader: CloudFormationReader | undefined;

function getCloudFormationReader(): CloudFormationReader {
  if (!cloudFormationReader) {
    cloudFormationReader = createCloudFormationReader();
  }
  return cloudFormationReader;
}

// Same lazy-singleton idiom for the ECS task reader behind runtime digest
// observation: constructing the client must not happen at module load.
let ecsTaskReader: EcsTaskReader | undefined;

function getEcsTaskReader(): EcsTaskReader {
  if (!ecsTaskReader) {
    const client = new ECSClient({});
    ecsTaskReader = {
      async listTasks(input) {
        const response = await client.send(
          new ListTasksCommand({ cluster: input.cluster, serviceName: input.serviceName }),
        );
        return { taskArns: response.taskArns ?? [] };
      },
      async describeTasks(input) {
        const response = await client.send(
          new DescribeTasksCommand({ cluster: input.cluster, tasks: input.tasks }),
        );
        return {
          tasks: (response.tasks ?? []).map((task) => ({
            lastStatus: task.lastStatus,
            containers: (task.containers ?? []).map((container) => ({
              imageDigest: container.imageDigest,
            })),
          })),
        };
      },
    };
  }
  return ecsTaskReader;
}

let stackInstaller: StackInstaller | undefined;

// Lazy readers behind runtime health observation — same construct-on-first-use
// rule as the reader above.
let ecsServiceReader: EcsServiceReader | undefined;
let targetHealthReader: TargetHealthReader | undefined;

function getEcsServiceReader(): EcsServiceReader {
  if (!ecsServiceReader) {
    const client = new ECSClient({});
    ecsServiceReader = {
      async describeServices(input) {
        const response = await client.send(
          new DescribeServicesCommand({ cluster: input.cluster, services: input.services }),
        );
        return {
          services: (response.services ?? []).map((service) => ({
            desiredCount: service.desiredCount ?? undefined,
            runningCount: service.runningCount ?? undefined,
            deployments: (service.deployments ?? []).map((deployment) => ({
              status: deployment.status ?? undefined,
              rolloutState: deployment.rolloutState ?? undefined,
            })),
          })),
        };
      },
    };
  }
  return ecsServiceReader;
}

function getTargetHealthReader(): TargetHealthReader {
  if (!targetHealthReader) {
    const client = new ElasticLoadBalancingV2Client({});
    targetHealthReader = {
      async describeTargetHealth(input) {
        const response = await client.send(
          new DescribeTargetHealthCommand({ TargetGroupArn: input.targetGroupArn }),
        );
        return {
          targets: (response.TargetHealthDescriptions ?? []).map((description) => ({
            state: description.TargetHealth?.State ?? undefined,
          })),
        };
      },
    };
  }
  return targetHealthReader;
}

// The ECS write client behind deploy/rollback/restart. Field-by-field
// adaptation between the seam's copy-shape and the SDK's register input —
// AWS owns revision/status/registration fields and rejects them on register.
let ecsDeployClient: EcsDeployClient | undefined;

function getEcsDeployClient(): EcsDeployClient {
  if (!ecsDeployClient) {
    const client = new ECSClient({});
    ecsDeployClient = {
      async describeServices(input) {
        const response = await client.send(
          new DescribeServicesCommand({ cluster: input.cluster, services: input.services }),
        );
        return {
          services: (response.services ?? []).map((service) => ({
            desiredCount: service.desiredCount ?? undefined,
            runningCount: service.runningCount ?? undefined,
            taskDefinition: service.taskDefinition ?? undefined,
            deployments: (service.deployments ?? []).map((deployment) => ({
              status: deployment.status ?? undefined,
              rolloutState: deployment.rolloutState ?? undefined,
            })),
          })),
        };
      },
      async describeTaskDefinition(input) {
        const response = await client.send(
          new DescribeTaskDefinitionCommand({ taskDefinition: input.taskDefinition }),
        );
        const taskDefinition = response.taskDefinition;
        return {
          taskDefinition: {
            family: taskDefinition?.family ?? undefined,
            cpu: taskDefinition?.cpu ?? undefined,
            memory: taskDefinition?.memory ?? undefined,
            networkMode: taskDefinition?.networkMode ?? undefined,
            requiresCompatibilities: taskDefinition?.requiresCompatibilities ?? undefined,
            executionRoleArn: taskDefinition?.executionRoleArn ?? undefined,
            taskRoleArn: taskDefinition?.taskRoleArn ?? undefined,
            containerDefinitions: (taskDefinition?.containerDefinitions ?? []).map(
              (container) => ({ ...container }),
            ),
            ...(taskDefinition?.volumes ? { volumes: taskDefinition.volumes } : {}),
          },
        };
      },
      async registerTaskDefinition(input) {
        if (!input.family) throw new Error('Cannot register a task definition without a family');
        // The seam copies fields as plain strings; the SDK narrows them to
        // its enum types. The values came from DescribeTaskDefinition, so
        // they are already valid members — the cast is the seam boundary.
        const response = await client.send(
          new RegisterTaskDefinitionCommand({
            ...input,
            family: input.family,
          } as RegisterTaskDefinitionCommandInput),
        );
        const arn = response.taskDefinition?.taskDefinitionArn;
        if (!arn) throw new Error('RegisterTaskDefinition returned no task definition ARN');
        return { taskDefinitionArn: arn };
      },
      async updateService(input) {
        await client.send(
          new UpdateServiceCommand({
            cluster: input.cluster,
            service: input.service,
            ...(input.taskDefinition !== undefined ? { taskDefinition: input.taskDefinition } : {}),
            ...(input.forceNewDeployment !== undefined
              ? { forceNewDeployment: input.forceNewDeployment }
              : {}),
          }),
        );
      },
      async listTasks(input) {
        const response = await client.send(
          new ListTasksCommand({ cluster: input.cluster, serviceName: input.serviceName }),
        );
        return { taskArns: response.taskArns ?? [] };
      },
      async describeTasks(input) {
        const response = await client.send(
          new DescribeTasksCommand({ cluster: input.cluster, tasks: input.tasks }),
        );
        return {
          tasks: (response.tasks ?? []).map((task) => ({
            containers: (task.containers ?? []).map((container) => ({
              imageDigest: container.imageDigest ?? undefined,
            })),
          })),
        };
      },
    };
  }
  return ecsDeployClient;
}

function getStackInstaller(): StackInstaller {
  if (!stackInstaller) {
    stackInstaller = createStackInstaller();
  }
  return stackInstaller;
}

let pendingStore: PendingStore | undefined;

/**
 * The pending-command store, keyed by the installation.
 *
 * Falls back to an in-memory store when there is no installation id: that
 * only happens in a misconfigured relay, which `relayHandler` refuses to
 * poll anyway, and a process-local store is a safer thing to hand back than
 * a parameter name built from an empty string.
 */
function getPendingStore(installationId: string): PendingStore {
  if (!pendingStore) {
    pendingStore = installationId
      ? createPendingStore(pendingParameterName(installationId))
      : memoryPendingStore();
  }
  return pendingStore;
}

// Recovery clients follow the same lazy idiom: constructed on the first
// retried INSTALL, never at module load.
let recoveryCloudFormation: RecoveryCloudFormation | undefined;
let rdsCleanupClient: RdsCleanupClient | undefined;
let cacheCleanupClient: CacheCleanupClient | undefined;

function getRecoveryCloudFormation(): RecoveryCloudFormation {
  if (!recoveryCloudFormation) {
    recoveryCloudFormation = createRecoveryCloudFormation();
  }
  return recoveryCloudFormation;
}

function getRdsCleanupClient(): RdsCleanupClient {
  if (!rdsCleanupClient) {
    rdsCleanupClient = createRealRdsCleanupClient();
  }
  return rdsCleanupClient;
}

function getCacheCleanupClient(): CacheCleanupClient {
  if (!cacheCleanupClient) {
    cacheCleanupClient = createRealCacheCleanupClient();
  }
  return cacheCleanupClient;
}

// ── Default command executors ────────────────────────────────────────────────

/**
 * A verifying executor: run the command's underlying step (still a stub for
 * INSTALL, DEPLOY_RELEASE and ROLLBACK today), then prove the account backs
 * it up before reporting success. Shared across all three command types
 * rather than duplicated, so the gate cannot drift between them.
 *
 * What this proves, precisely: the application stack exists and its
 * expected resources (ECS service, load balancer, database, storage, and —
 * when required — cache) are present in a complete state. What it does NOT
 * prove: which release is running. That needs the running task's image
 * digest, which this branch does not fetch. A verified DEPLOY_RELEASE or
 * ROLLBACK means the stack is intact — it does not mean the new (or prior)
 * release is the one actually serving traffic. This is a floor under the
 * false-Healthy hole, not a full release-correctness check.
 *
 * A throw from verification is a failure, not a pass: a command we cannot
 * confirm is indistinguishable from one that did not happen.
 */
export function createVerifyingExecutor(
  verify: (installationId: string, command: RelayCommand) => Promise<VerificationResult>,
): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );

    const installationId = process.env['DEPLOYZ_INSTALLATION_ID'] ?? '';

    let result: VerificationResult;
    try {
      result = await verify(installationId, command);
    } catch (err) {
      result = {
        verified: false,
        checks: [],
        reason: `Verification could not run: ${String(err)}`,
      };
    }

    console.log(
      JSON.stringify({
        event: 'relay:command-verified',
        commandId: command.id,
        type: command.type,
        installationId,
        verified: result.verified,
        ...(result.reason ? { reason: result.reason } : {}),
      }),
    );

    if (!result.verified) {
      return {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: false,
        error: result.reason ?? 'Installation could not be verified',
        failureCode: 'STACK_CREATE_FAILED',
        output: { checks: result.checks },
      };
    }

    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output: { executed: true, type: command.type, checks: result.checks },
    };
  };
}

// ── The INSTALL executor ─────────────────────────────────────────────────────

/**
 * Everything the INSTALL executor and its resumer need, as injectable
 * seams. `install` and `verify` are functions rather than clients so the
 * whole provision-then-prove sequence tests without AWS, and so the two
 * entry points below cannot drift apart — both close over the same pair.
 */
export interface InstallExecutorDeps {
  readonly installationId: string;
  /** Public URL of the published application template. */
  readonly templateUrl: string;
  readonly install: (options: InstallRequest) => Promise<InstallOutcome>;
  readonly verify: (options: VerifyRequest) => Promise<VerificationResult>;
  readonly pending: PendingStore;
  /**
   * First-install recovery. Runs before `install`, and only when the command
   * payload carries `recovery.neverInstalled` — the control plane sets that
   * on its retry-install route, after proving no INSTALL ever succeeded.
   */
  readonly recover?: (stackName: string) => Promise<RecoveryReport>;
  /** CloudFormation execution role ARN (`role/deployz/*`), when configured. */
  readonly executionRoleArn?: string;
  /** Clock for the pending marker's `startedAt`. */
  readonly now?: () => string;
}

/** What `install` is asked for — `InstallOptions` minus the client seam. */
export type InstallRequest = Omit<InstallOptions, 'installer'>;

/** What `verify` is asked for — `VerifyOptions` minus the client seam. */
export type VerifyRequest = Omit<VerifyOptions, 'cfn'>;

/**
 * Run an install to whatever conclusion is available right now.
 *
 * Two questions, asked in order and never merged: CloudFormation is asked
 * to build the stack and say how that went, and then — only if it says it
 * worked — `verifyInstallation` independently confirms the resources are
 * actually there. A `CREATE_COMPLETE` that fails verification is a failure:
 * the whole point of the second question is that the first one's answer is
 * not evidence on its own.
 *
 * A stack still in progress produces neither answer. That is reported as
 * `deferred` rather than guessed at.
 */
async function settleInstall(
  deps: InstallExecutorDeps,
  request: { stackName: string; payload: Record<string, unknown> },
): Promise<
  | { readonly deferred: true; readonly status: string }
  | {
      readonly deferred: false;
      readonly success: boolean;
      readonly error?: string;
      readonly output: Record<string, unknown>;
    }
> {
  const verifyOptions = readVerifyOptionsFromPayload(request.payload);

  const outcome = await deps.install({
    installationId: deps.installationId,
    templateUrl: deps.templateUrl,
    stackName: request.stackName,
    parameters: readInstallParametersFromPayload(request.payload),
    ...(deps.executionRoleArn !== undefined ? { executionRoleArn: deps.executionRoleArn } : {}),
  });

  if (outcome.state === 'in-progress') {
    return { deferred: true, status: outcome.status };
  }

  if (outcome.state === 'failed') {
    // No verification here. The stack CloudFormation just rolled back is
    // not a stack to check for an ECS service, and a second failing answer
    // would only bury the first one's reason — which is the one that says
    // what actually went wrong.
    return {
      deferred: false,
      success: false,
      error: outcome.reason,
      output: { stackStatus: outcome.status ?? null, outputs: outcome.outputs },
    };
  }

  let verification: VerificationResult;
  try {
    verification = await deps.verify({
      installationId: deps.installationId,
      stackName: request.stackName,
      ...verifyOptions,
    });
  } catch (err) {
    verification = {
      verified: false,
      checks: [],
      reason: `Verification could not run: ${String(err)}`,
    };
  }

  return {
    deferred: false,
    success: verification.verified,
    ...(verification.verified
      ? {}
      : { error: verification.reason ?? 'Installation could not be verified' }),
    output: {
      stackStatus: outcome.status,
      outputs: outcome.outputs,
      checks: verification.checks,
    },
  };
}

/**
 * Run the requested first-install recovery, if the command asked for one.
 *
 * The payload flag is control-plane-shaped (`Record<string, unknown>`), so
 * it is checked defensively — anything other than an explicit `true` means
 * no recovery, and a command with no `recover` seam (e.g. a test double)
 * skips it rather than crashing.
 *
 * A refusal phase (live or in-progress stack) is not an error: recovery
 * falls through and `settleInstall` reports the stack's real state honestly.
 */
async function runRequestedRecovery(
  deps: InstallExecutorDeps,
  command: RelayCommand,
  stackName: string,
): Promise<RecoveryReport | undefined> {
  const recovery = command.payload['recovery'] as { neverInstalled?: unknown } | undefined;
  if (recovery?.neverInstalled !== true || !deps.recover) {
    return undefined;
  }

  const report = await deps.recover(stackName);
  console.log(
    JSON.stringify({
      event: 'relay:install-recovery',
      commandId: command.id,
      installationId: deps.installationId,
      phase: report.phase,
      lastStackStatus: report.lastStackStatus,
      orphansDeleted: report.orphansDeleted,
    }),
  );
  return report;
}

/**
 * The INSTALL executor: provision the application stack, then prove it.
 *
 * Unlike `createVerifyingExecutor`, which only ever looked, this one
 * actually creates the stack. It keeps the same gate on the way out — a
 * success is reported only when `verifyInstallation` independently agrees —
 * so implementing INSTALL does not reopen the hole that gate was added to
 * close.
 */
export function createInstallExecutor(deps: InstallExecutorDeps): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );

    if (!deps.templateUrl) {
      return failure(
        command,
        'No application template URL is configured for this relay — the vendor has not published one yet',
      );
    }

    const stackName = readVerifyOptionsFromPayload(command.payload).stackName ?? DEFAULT_STACK_NAME;
    const recoveryReport = await runRequestedRecovery(deps, command, stackName);
    const settled = await settleInstall(deps, { stackName, payload: command.payload });

    if (!settled.deferred) {
      logInstall(command, stackName, settled.success, settled.error);
      const output = {
        ...settled.output,
        ...(recoveryReport ? { recovery: recoveryReport } : {}),
      };
      return settled.success
        ? {
            commandId: command.id,
            idempotencyKey: command.idempotencyKey,
            success: true,
            output: { executed: true, type: command.type, ...output },
          }
        : {
            commandId: command.id,
            idempotencyKey: command.idempotencyKey,
            success: false,
            error: settled.error ?? 'Installation could not be verified',
            failureCode: 'STACK_CREATE_FAILED',
            output,
          };
    }

    // The stack outlived this invocation. Record what we owe an answer to
    // BEFORE deferring — a deferral the next poll cannot find is a job that
    // sits in RUNNING forever, which is worse than an honest failure.
    const recorded = await deps.pending.write({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
      stackName,
      startedAt: (deps.now ?? (() => new Date().toISOString()))(),
      payload: command.payload,
    });

    if (!recorded) {
      return failure(
        command,
        `Stack "${stackName}" is still ${settled.status}, but the relay could not record that it ` +
          'must report back — failing now rather than leaving the install unaccounted for',
      );
    }

    console.log(
      JSON.stringify({
        event: 'relay:command-deferred',
        commandId: command.id,
        type: command.type,
        stackName,
        status: settled.status,
      }),
    );

    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      deferred: true,
    };
  };
}

/**
 * The other half of `createInstallExecutor`: finish an install that an
 * earlier invocation started and report it against its original command id.
 *
 * Wired into the poll loop's `resume` hook, so it runs once per five-minute
 * tick until the stack settles.
 */
export function createInstallResumer(
  deps: InstallExecutorDeps,
): () => Promise<RelayCommandResult[]> {
  return async () => {
    const pending = await deps.pending.read();
    if (pending === null) return [];
    // The pending store holds ONE command of any type; each resumer only
    // settles its own, so a deferred deploy is never answered as an install.
    if (pending.type !== 'INSTALL') return [];

    const settled = await settleInstall(deps, {
      stackName: pending.stackName,
      payload: pending.payload,
    });

    if (settled.deferred) {
      console.log(
        JSON.stringify({
          event: 'relay:command-still-pending',
          commandId: pending.commandId,
          stackName: pending.stackName,
          status: settled.status,
          startedAt: pending.startedAt,
        }),
      );
      return [];
    }

    // Clear first: a result reported twice would re-emit the control
    // plane's install event on every poll for the life of the deployment.
    await deps.pending.clear();

    console.log(
      JSON.stringify({
        event: 'relay:command-resumed',
        commandId: pending.commandId,
        stackName: pending.stackName,
        success: settled.success,
        startedAt: pending.startedAt,
        ...(settled.error ? { reason: settled.error } : {}),
      }),
    );

    return [
      settled.success
        ? {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: true,
            output: { executed: true, type: pending.type, ...settled.output },
          }
        : {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: false,
            error: settled.error ?? 'Installation could not be verified',
            failureCode: 'STACK_CREATE_FAILED',
            output: settled.output,
          },
    ];
  };
}

function failure(command: RelayCommand, error: string): RelayCommandResult {
  return {
    commandId: command.id,
    idempotencyKey: command.idempotencyKey,
    success: false,
    error,
    failureCode: 'STACK_CREATE_FAILED',
  };
}

function logInstall(
  command: RelayCommand,
  stackName: string,
  success: boolean,
  error: string | undefined,
): void {
  console.log(
    JSON.stringify({
      event: 'relay:command-verified',
      commandId: command.id,
      type: command.type,
      stackName,
      verified: success,
      ...(error ? { reason: error } : {}),
    }),
  );
}

/**
 * Extract CloudFormation template parameter values from a command's payload.
 *
 * The application template's vendor secrets (`paramAppApiKey`,
 * `paramAppSigningSecret`) are `NoEcho` parameters, so their values can only
 * come from the caller. `payload` is shaped by the control plane, not by
 * this module, so every value is checked to be a string before it is sent:
 * CloudFormation parameter values are always strings, and a number or an
 * object reaching `CreateStack` surfaces as an opaque `ValidationError`
 * partway through an install rather than as the control-plane bug it is.
 */
export function readInstallParametersFromPayload(
  payload: Record<string, unknown>,
): Record<string, string> {
  const parameters = payload['parameters'];
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Extract verification overrides from a command's payload.
 *
 * `command.payload` is `Record<string, unknown>` — shaped by the control
 * plane, not by this module — so every field is validated defensively
 * before use rather than trusted or cast. A missing or wrongly-typed field
 * falls back to `verifyInstallation`'s own default, which is today's
 * behaviour (`redisRequired: false`, the default stack name).
 *
 * This is what keeps the relay's gate and the operator CLI's `--redis` flag
 * in agreement: without it, a deployment that requires Redis but has no
 * ElastiCache cluster would pass the relay gate and only get caught later,
 * by hand, via `audit:deployment`.
 *
 * The §59 `observe` hook (wired in `createRelayHandler`) is deliberately not
 * routed through this: it runs on every poll, outside any command, so it has
 * no payload to read — its defaults stay as they are.
 */
export function readVerifyOptionsFromPayload(
  payload: Record<string, unknown>,
): Pick<VerifyOptions, 'redisRequired' | 'stackName'> {
  const redisRequired = payload['redisRequired'];
  const stackName = payload['stackName'];

  return {
    ...(typeof redisRequired === 'boolean' ? { redisRequired } : {}),
    ...(typeof stackName === 'string' && stackName.length > 0 ? { stackName } : {}),
  };
}

/**
 * The production wiring for INSTALL: real CloudFormation, real SSM, real
 * verification, with the template URL and execution role supplied by the
 * bootstrap stack as environment variables.
 *
 * `budgetMs` bounds how long a single invocation watches the stack. It has
 * to stay comfortably under the relay Lambda's own timeout — a killed
 * invocation reports nothing at all, which is the one outcome the deferral
 * machinery cannot recover from, because the pending marker is written
 * on the way out.
 */
function createDefaultInstallDeps(installationId: string): InstallExecutorDeps {
  const budget = Number(process.env['DEPLOYZ_INSTALL_BUDGET_MS'] ?? '');
  const budgetMs = Number.isFinite(budget) && budget > 0 ? budget : undefined;
  const executionRoleArn = process.env['DEPLOYZ_APPLICATION_EXECUTION_ROLE_ARN'];

  return {
    installationId,
    templateUrl: process.env['DEPLOYZ_APPLICATION_TEMPLATE_URL'] ?? '',
    ...(executionRoleArn ? { executionRoleArn } : {}),
    install: (options) =>
      installApplicationStack({
        ...options,
        installer: getStackInstaller(),
        ...(budgetMs !== undefined ? { budgetMs } : {}),
      }),
    verify: (options) => verifyInstallation({ ...options, cfn: getCloudFormationReader() }),
    pending: getPendingStore(installationId),
    recover: (stackName) =>
      recoverFailedInstallStack(
        {
          cfn: getRecoveryCloudFormation(),
          rds: getRdsCleanupClient(),
          cache: getCacheCleanupClient(),
        },
        { stackName },
      ),
  };
}

/** The deploy-side twin of `createDefaultInstallDeps`. */
function deployResumerDeps(installationId: string): EcsDeployDeps {
  return {
    cfn: getCloudFormationReader(),
    ecs: getEcsDeployClient(),
    pending: getPendingStore(installationId),
    stackName: DEFAULT_STACK_NAME,
    installationId,
  };
}

/**
 * Default executors for the command vocabulary.
 *
 * ⚠️ FOUR OF THESE ARE STILL STUBS: REPORT_HEALTH, CONFIG_UPDATE, DESTROY,
 * MIGRATE and REFRESH_METADATA each log and report success without touching
 * the customer's account. The real implementations — config propagation,
 * stack deletion, migrations — are the remaining half of the product.
 *
 * INSTALL is now real: it creates the published application template as a
 * CloudFormation stack, watches it to a terminal state, and reports what
 * happened — still behind the same `verifyInstallation` gate, so a stack
 * CloudFormation calls complete but that does not contain the application
 * is a failure.
 *
 * DEPLOY_RELEASE, ROLLBACK and RESTART are real: they drive the ECS service
 * discovered through the application stack — immutable digest pinning for
 * deploy/rollback (see ./deploy.ts), a forced rolling redeployment for
 * restart.
 *
 * CONFIGURE_DOMAIN and REMOVE_DOMAIN are real.
 *
 * The command vocabulary + dispatch + idempotency layer around them IS real.
 */
function createDefaultExecutors(installDeps: InstallExecutorDeps): Record<string, CommandExecutor> {
  const noop: CommandExecutor = async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output: { executed: true, type: command.type },
    };
  };

  // Real ACM/ALB clients are lazy SDK singletons (see ./domain.js) — no AWS
  // SDK call happens until a domain command is actually executed, so this
  // stays safe to construct even in unit tests that never touch AWS.
  const domainExecutors = createDomainExecutors({
    ...createRealDomainAwsClients(),
    installationId: installDeps.installationId,
  });

  // The deploy executors share the ECS write seam behind a lazy SDK client
  // (same construct-on-first-use rule as the readers above).
  const deployDeps: EcsDeployDeps = {
    cfn: getCloudFormationReader(),
    ecs: getEcsDeployClient(),
    pending: getPendingStore(installDeps.installationId),
    stackName: DEFAULT_STACK_NAME,
    installationId: installDeps.installationId,
  };

  return {
    INSTALL: createInstallExecutor(installDeps),
    REPORT_HEALTH: noop,
    DEPLOY_RELEASE: createEcsDeployExecutor(deployDeps),
    ROLLBACK: createEcsDeployExecutor(deployDeps),
    RESTART: createRestartExecutor(deployDeps),
    CONFIG_UPDATE: noop,
    DESTROY: noop,
    MIGRATE: noop,
    REFRESH_METADATA: noop,
    CONFIGURE_DOMAIN: domainExecutors.CONFIGURE_DOMAIN,
    REMOVE_DOMAIN: domainExecutors.REMOVE_DOMAIN,
  };
}

// ── Handler factory (injectable deps for testing) ────────────────────────────

export interface RelayHandlerDeps {
  secretsClient: SecretsClient;
  fetchFn: FetchFn;
  executors?: Record<string, CommandExecutor>;
  idempotency?: IdempotencyStore;
  /**
   * Overrides the §59 observed-state hook wired into every poll cycle. When
   * omitted, falls back to the real `verifyInstallation` closure over the
   * lazy `CloudFormationReader` singleton — the same construct-on-first-use
   * pattern as `executors`/`domain.js`'s `getAcmSdkClient()`. Tests that
   * don't want a real AWS call on every poll (i.e. all of them) should
   * inject a stub here.
   */
  observe?: PollDependencies['observe'];
  /**
   * Overrides the deferred-command resume hook. When omitted, falls back to
   * `createInstallResumer` over the production install/verify/pending
   * wiring. Tests inject a stub here for the same reason as `observe`: the
   * real one reads SSM on every poll.
   */
  resume?: PollDependencies['resume'];
  /**
   * Overrides the relay identity (account/version/capabilities) reported at
   * enrollment and on every heartbeat. When omitted, derived from the
   * Lambda invocation context and environment (see identity.ts). Tests
   * inject a stub instead of fabricating a context.
   */
  identity?: PollDependencies['identity'];
  /**
   * Overrides the running-image-digest observation wired into every health
   * report. When omitted, discovers the ECS service through the application
   * stack and reads the digest off the running tasks.
   */
  observeImage?: PollDependencies['observeImage'];
  /**
   * Overrides the runtime health observation (ECS counts, target health,
   * rollout state) wired into every health report.
   */
  observeHealth?: PollDependencies['observeHealth'];
}

/**
 * Create a relay handler function with injectable dependencies.
 *
 * The returned function matches the Lambda handler signature
 * `(event: ScheduledEvent, context?) => Promise<void>` so it can be wired
 * directly as the CDK NodejsFunction handler.
 */
export function createRelayHandler(deps: RelayHandlerDeps) {
  const installDeps = createDefaultInstallDeps(process.env['DEPLOYZ_INSTALLATION_ID'] ?? '');
  const executors = deps.executors ?? createDefaultExecutors(installDeps);
  const idempotency = deps.idempotency ?? new IdempotencyStore();

  // Auth state persists across invocations within the same warm Lambda
  // container. On cold start it's re-created from Secrets Manager.
  let authState: ReturnType<typeof createAuthState> | undefined;

  return async function relayHandler(
    event: ScheduledEvent,
    context?: { invokedFunctionArn?: string },
  ): Promise<void> {
    const installationId = process.env['DEPLOYZ_INSTALLATION_ID'];
    const secretArn = process.env['DEPLOYZ_CREDENTIAL_SECRET_ARN'];
    const controlPlaneUrl = process.env['DEPLOYZ_CONTROL_PLANE_URL'];
    // Set by the bootstrap stack from its EnrollmentCode parameter. Without
    // it the control plane has no way to tell which deployment this relay
    // belongs to — the installation id above is minted here, in the
    // customer's account, and has never been seen by the control plane.
    const enrollmentCode = process.env['DEPLOYZ_ENROLLMENT_CODE'];

    if (!installationId || !secretArn || !controlPlaneUrl || !enrollmentCode) {
      console.error(
        JSON.stringify({
          event: 'relay:missing-config',
          hasInstallationId: !!installationId,
          hasSecretArn: !!secretArn,
          hasControlPlaneUrl: !!controlPlaneUrl,
          hasEnrollmentCode: !!enrollmentCode,
        }),
      );
      return;
    }

    // Read the credential on cold start or if auth state was lost.
    if (!authState) {
      try {
        const token = await readCredential(deps.secretsClient, secretArn);
        authState = createAuthState(installationId, token);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'relay:credential-read-failed',
            error: String(err),
          }),
        );
        return;
      }
    }

    const pollDeps: PollDependencies = {
      fetchFn: deps.fetchFn,
      controlPlaneUrl,
      installationId,
      enrollmentCode,
      executors,
      idempotency,
      observe:
        deps.observe ??
        (() => verifyInstallation({ cfn: getCloudFormationReader(), installationId })),
      // One pending store, several resumers: each settles only its own
      // command type, so composing them is safe.
      resume:
        deps.resume ??
        (async () => {
          const installResults = await createInstallResumer(installDeps)();
          if (installResults.length > 0) return installResults;
          return createEcsDeployResumer(deployResumerDeps(installDeps.installationId))();
        }),
      identity: deps.identity ?? readRelayIdentity(context),
      observeImage:
        deps.observeImage ??
        (() =>
          observeRunningImageDigest(
            {
              cfn: getCloudFormationReader(),
              ecs: getEcsTaskReader(),
              installationId,
            },
            DEFAULT_STACK_NAME,
          )),
      observeHealth:
        deps.observeHealth ??
        (() =>
          observeRuntimeHealth(
            {
              cfn: getCloudFormationReader(),
              ecs: getEcsServiceReader(),
              elb: getTargetHealthReader(),
            },
            DEFAULT_STACK_NAME,
          )),
    };

    const result = await pollOnce(pollDeps, authState);

    console.log(
      JSON.stringify({
        event: 'relay:poll-complete',
        installationId,
        scheduledAt: event.time ?? new Date().toISOString(),
        ...result,
      }),
    );
  };
}

/**
 * Production handler — wired with real `globalThis.fetch` and a real
 * Secrets Manager client (injected by the CDK bundling or Lambda layer).
 *
 * The `handler` export is what the CDK NodejsFunction invokes.
 */
export const handler = createRelayHandler({
  secretsClient: {
    async getSecretValue(params: { SecretId: string }) {
      const client = new AwsSecretsManagerClient({});
      const response = await client.send(new GetSecretValueCommand(params));
      return { SecretString: response.SecretString ?? undefined };
    },
  },
  fetchFn: globalThis.fetch.bind(globalThis),
});
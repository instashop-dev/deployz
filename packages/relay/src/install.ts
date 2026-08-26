/**
 * INSTALL — provision the customer's application stack.
 *
 * This is the write side of what `./verify.ts` reads. The relay creates the
 * published application template as a CloudFormation stack in the customer's
 * own account, watches it to a terminal state, and reports what actually
 * happened. `verifyInstallation()` then re-asks CloudFormation the same
 * question independently, so a success claim is never taken on this module's
 * word alone.
 *
 * Three properties this module is built around:
 *
 * 1. **Stack-level tags, not template tags.** The `deployz:installation` tag
 *    goes on the `CreateStack` call itself. The relay's IAM condition
 *    (`aws:RequestTag/deployz:installation`) is evaluated against that tag,
 *    and `verifyInstallation`'s `stack-tagged` check reads it back off the
 *    stack. CDK's `Tags.of(...)` writes per-resource template tags, which
 *    neither of those two ever look at — passing only those would deny the
 *    create and then fail the verification.
 *
 * 2. **Idempotent.** A re-delivered INSTALL, a resumed one, or a retry after
 *    a lost result must never create a second stack. The stack's own
 *    existence is the record: describe first, create only when there is
 *    nothing there, and treat an `AlreadyExists` race as an in-flight create.
 *
 * 3. **Bounded, resumable waiting.** The application stack (VPC + NAT, RDS,
 *    ALB, and an ECS service CloudFormation waits to stabilise) routinely
 *    takes longer than a Lambda invocation is allowed to live. Rather than
 *    guess, this returns `in-progress` when the time budget runs out — a
 *    third answer that is neither success nor failure, so the caller can
 *    hand the same question back to the next poll instead of inventing a
 *    verdict.
 */

import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  type Capability,
} from '@aws-sdk/client-cloudformation';
import { DEFAULT_APPLICATION_STACK_NAME } from '@deployz/contracts';

/** The stack tag both the relay's IAM condition and the verifier read. */
export const INSTALLATION_TAG = 'deployz:installation';

/**
 * The application stack creates IAM roles for the ECS tasks, so
 * CloudFormation refuses the create without an explicit acknowledgement.
 * `CAPABILITY_NAMED_IAM` is included alongside it because the stack's
 * CloudFormation execution role is looked up by a fixed path.
 */
const CAPABILITIES = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'] as const;

/** Terminal statuses that mean the stack is up. */
const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * Terminal statuses that mean the stack is not up and will not become up
 * without another operation. `ROLLBACK_COMPLETE` is the one to note: the
 * stack still exists, so "the stack is there" is not the same question as
 * "the install worked".
 */
const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'CREATE_FAILED',
  'ROLLBACK_COMPLETE',
  'ROLLBACK_FAILED',
  'DELETE_COMPLETE',
  'DELETE_FAILED',
  'UPDATE_FAILED',
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_FAILED',
  'IMPORT_ROLLBACK_COMPLETE',
  'IMPORT_ROLLBACK_FAILED',
]);

// ── Observed shapes ─────────────────────────────────────────────────────────

export interface StackState {
  readonly status: string;
  /** CloudFormation's own explanation, when it gave one. */
  readonly statusReason?: string;
  readonly outputs: Readonly<Record<string, string>>;
}

export interface CreateStackInput {
  readonly stackName: string;
  readonly templateUrl: string;
  readonly parameters: Readonly<Record<string, string>>;
  /** Stack-level tags — the `Tags` parameter of `CreateStack`. */
  readonly tags: Readonly<Record<string, string>>;
  readonly capabilities: readonly string[];
  /** CloudFormation execution role. Absent means "use the caller's rights". */
  readonly roleArn?: string;
}

/**
 * `AlreadyExists` is called out separately from other refusals because it is
 * the one that is not a problem: two invocations raced, the earlier one won,
 * and the right response is to watch the stack the winner created.
 */
export type CreateStackOutcome =
  | { readonly created: true; readonly stackId: string }
  | { readonly created: false; readonly alreadyExists: true }
  | {
      readonly created: false;
      readonly alreadyExists: false;
      readonly errorCode?: string;
      readonly message: string;
    };

/** The injectable seam. Implementations must never throw. */
export interface StackInstaller {
  createStack(input: CreateStackInput): Promise<CreateStackOutcome>;
  /** `null` when there is no such stack — including when it cannot be read. */
  describeStack(stackName: string): Promise<StackState | null>;
}

// ── Options and outcome ─────────────────────────────────────────────────────

export interface InstallOptions {
  readonly installer: StackInstaller;
  readonly installationId: string;
  /** Public HTTPS URL of the published application template. */
  readonly templateUrl: string;
  /** Defaults to `DEFAULT_APPLICATION_STACK_NAME`. */
  readonly stackName?: string;
  /** Template parameter values, by parameter name. */
  readonly parameters?: Readonly<Record<string, string>>;
  /** CloudFormation execution role ARN (`role/deployz/*`). */
  readonly executionRoleArn?: string;
  /** How long to watch before answering `in-progress`. Defaults to 3 minutes. */
  readonly budgetMs?: number;
  /** Gap between `DescribeStacks` calls. Defaults to 15 seconds. */
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type InstallOutcome =
  | {
      readonly state: 'succeeded';
      readonly status: string;
      readonly outputs: Readonly<Record<string, string>>;
    }
  | {
      readonly state: 'failed';
      readonly status?: string;
      readonly reason: string;
      readonly outputs: Readonly<Record<string, string>>;
    }
  | { readonly state: 'in-progress'; readonly status: string };

const DEFAULT_BUDGET_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * Create the application stack if it is not already there, then watch it
 * until it settles or the time budget runs out.
 *
 * Never throws: an installer that breaks its no-throw contract still comes
 * back as `failed`, because a command whose outcome we cannot determine must
 * not be reported as one that worked.
 */
export async function installApplicationStack(options: InstallOptions): Promise<InstallOutcome> {
  try {
    return await run(options);
  } catch (error) {
    return {
      state: 'failed',
      reason: `Install could not run: ${message(error)}`,
      outputs: {},
    };
  }
}

async function run(options: InstallOptions): Promise<InstallOutcome> {
  const {
    installer,
    installationId,
    templateUrl,
    stackName = DEFAULT_APPLICATION_STACK_NAME,
    parameters = {},
    budgetMs = DEFAULT_BUDGET_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = options;

  const deadline = now() + budgetMs;

  // Describe before create. This is what makes a re-delivered or resumed
  // INSTALL safe: an existing stack is adopted, never duplicated.
  const existing = await installer.describeStack(stackName);
  if (existing !== null) {
    const settled = settle(existing, stackName);
    if (settled) return settled;
  } else {
    const created = await installer.createStack({
      stackName,
      templateUrl,
      parameters,
      // The single tag both the IAM condition and the verifier depend on.
      tags: { [INSTALLATION_TAG]: installationId },
      capabilities: [...CAPABILITIES],
      ...(options.executionRoleArn !== undefined ? { roleArn: options.executionRoleArn } : {}),
    });

    if (!created.created && !created.alreadyExists) {
      const code = created.errorCode ? `${created.errorCode}: ` : '';
      return {
        state: 'failed',
        reason: `CloudFormation refused to create "${stackName}" — ${code}${created.message}`,
        outputs: {},
      };
    }
  }

  // Watch it settle.
  let last: StackState | null = existing;
  for (;;) {
    if (now() >= deadline) {
      return { state: 'in-progress', status: last?.status ?? 'CREATE_IN_PROGRESS' };
    }
    await sleep(pollIntervalMs);
    if (now() >= deadline) {
      return { state: 'in-progress', status: last?.status ?? 'CREATE_IN_PROGRESS' };
    }

    const state = await installer.describeStack(stackName);
    if (state === null) {
      // It was there a moment ago. Something deleted it, or the read stopped
      // being permitted — either way this install did not produce a stack.
      return {
        state: 'failed',
        reason: `Stack "${stackName}" is no longer readable — it was deleted, or the relay lost access to it`,
        outputs: {},
      };
    }

    last = state;
    const settled = settle(state, stackName);
    if (settled) return settled;
  }
}

/** A verdict, or `undefined` while the stack is still moving. */
function settle(state: StackState, stackName: string): InstallOutcome | undefined {
  if (SUCCESS_STATUSES.has(state.status)) {
    return { state: 'succeeded', status: state.status, outputs: state.outputs };
  }
  if (FAILURE_STATUSES.has(state.status)) {
    const because = state.statusReason ? ` — ${state.statusReason}` : '';
    return {
      state: 'failed',
      status: state.status,
      reason: `Stack "${stackName}" finished in ${state.status}${because}`,
      outputs: state.outputs,
    };
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Real installer ──────────────────────────────────────────────────────────

/** The one method of the SDK client this module uses. */
interface SendsCommands {
  send(command: unknown): Promise<unknown>;
}

/**
 * Wrap a CloudFormation client as an installer.
 *
 * Every throw is mapped here, so the orchestration above never sees an
 * exception. `describeStack` maps ANY failure to `null` — "not there" and
 * "not readable" are the same answer to "is there a stack to adopt?", and
 * conflating them is safe in that direction: the worst case is an extra
 * `CreateStack` attempt, which CloudFormation itself rejects with
 * `AlreadyExistsException`.
 *
 * Split out from `createStackInstaller` so it can be tested against a fake
 * client with no SDK construction, matching `toReader` in `./verify.ts`.
 */
export function toInstaller(client: SendsCommands): StackInstaller {
  return {
    async createStack(input: CreateStackInput): Promise<CreateStackOutcome> {
      try {
        const response = (await client.send(
          new CreateStackCommand({
            StackName: input.stackName,
            TemplateURL: input.templateUrl,
            Parameters: Object.entries(input.parameters).map(([key, value]) => ({
              ParameterKey: key,
              ParameterValue: value,
            })),
            // The `Tags` parameter — stack-level tags, which CloudFormation
            // also propagates onto every resource that supports tagging.
            Tags: Object.entries(input.tags).map(([key, value]) => ({
              Key: key,
              Value: value,
            })),
            Capabilities: [...input.capabilities] as Capability[],
            ...(input.roleArn !== undefined ? { RoleARN: input.roleArn } : {}),
          }),
        )) as { StackId?: string };

        return { created: true, stackId: response.StackId ?? '' };
      } catch (err) {
        const errorCode = err instanceof Error ? err.name : undefined;
        if (errorCode === 'AlreadyExistsException') {
          return { created: false, alreadyExists: true };
        }
        return {
          created: false,
          alreadyExists: false,
          ...(errorCode !== undefined ? { errorCode } : {}),
          message: message(err),
        };
      }
    },

    async describeStack(stackName: string): Promise<StackState | null> {
      try {
        const response = (await client.send(
          new DescribeStacksCommand({ StackName: stackName }),
        )) as {
          Stacks?: {
            StackStatus?: string;
            StackStatusReason?: string;
            Outputs?: { OutputKey?: string; OutputValue?: string }[];
          }[];
        };

        const stack = response.Stacks?.[0];
        if (!stack?.StackStatus) return null;

        const outputs: Record<string, string> = {};
        for (const output of stack.Outputs ?? []) {
          if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
            outputs[output.OutputKey] = output.OutputValue;
          }
        }

        return {
          status: stack.StackStatus,
          ...(stack.StackStatusReason !== undefined
            ? { statusReason: stack.StackStatusReason }
            : {}),
          outputs,
        };
      } catch {
        return null;
      }
    },
  };
}

/** Production installer — credentials come from the standard SDK chain. */
export function createStackInstaller(region?: string): StackInstaller {
  return toInstaller(new CloudFormationClient(region === undefined ? {} : { region }));
}

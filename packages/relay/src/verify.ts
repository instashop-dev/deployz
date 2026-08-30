/**
 * Installation verification — does the customer's account actually contain
 * the application the control plane believes is deployed?
 *
 * This exists because a relay command reporting `success: true` is, on its
 * own, worth nothing: it is a claim made by the same process that was
 * supposed to do the work. Verification is a second, independent question
 * asked of CloudFormation directly.
 *
 * Two API calls answer it — the stack's existence and status, and its
 * resource inventory. That is deliberately narrower than sweeping the
 * account: the relay's IAM is scoped by the `deployz:installation` tag, and
 * most account-wide list calls cannot carry that condition.
 *
 * EVERY failure mode resolves to `verified: false`. A verifier that treated
 * an unreadable answer as a good one would reproduce the bug it exists to
 * catch.
 *
 * The no-throw guarantee is enforced here, not merely documented on
 * `CloudFormationReader`: the whole body runs inside a try/catch, so even a
 * reader implementation that breaks its contract (an unmapped error type, a
 * network-layer throw) still resolves to `verified: false` rather than
 * crashing the caller.
 */

import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { DEFAULT_APPLICATION_STACK_NAME } from '@deployz/contracts';

// ── Observed shapes ─────────────────────────────────────────────────────────

export interface StackSummary {
  readonly stackName: string;
  readonly status: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface StackResource {
  readonly logicalId: string;
  readonly type: string;
  readonly status: string;
  /** Physical id (e.g. an ECS service ARN); absent for some resource states. */
  readonly physicalId?: string;
}

/**
 * A failed lookup carries the AWS error code when there was one. "The stack
 * is missing" and "I am not allowed to look" are both `found: false` — the
 * fail-closed rule makes them equivalent for the verdict — but an operator
 * acts differently on each, so the reason preserves which it was.
 */
export type StackLookup =
  | { readonly found: true; readonly stack: StackSummary }
  | { readonly found: false; readonly errorCode?: string };

/** The injectable seam. Implementations must never throw. */
export interface CloudFormationReader {
  describeStack(stackName: string): Promise<StackLookup>;
  describeStackResources(stackName: string): Promise<StackResource[]>;
}

// ── Verification ────────────────────────────────────────────────────────────

export interface VerifyOptions {
  readonly cfn: CloudFormationReader;
  readonly installationId: string;
  /** Defaults to `DEFAULT_APPLICATION_STACK_NAME`. */
  readonly stackName?: string;
  /** Expect an ElastiCache cluster. Defaults to false. */
  readonly redisRequired?: boolean;
}

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
  /**
   * A failed informational check does not fail the verification. Used for
   * the cache check on applications that do not require Redis: reporting
   * its absence is what lets the dashboard say "Not provisioned" instead of
   * "Not reporting", but absence is not an installation failure there.
   */
  readonly required?: boolean;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
  /** Present when `verified` is false — the first failing check's detail. */
  readonly reason?: string;
}

const INSTALLATION_TAG = 'deployz:installation';

/** Stack and resource statuses that mean "this finished, and it worked". */
const COMPLETE_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

const REQUIRED_RESOURCES = [
  { name: 'compute', type: 'AWS::ECS::Service', label: 'ECS service' },
  { name: 'ingress', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', label: 'load balancer' },
  { name: 'database', type: 'AWS::RDS::DBInstance', label: 'database' },
  { name: 'storage', type: 'AWS::S3::Bucket', label: 'storage bucket' },
] as const;

const CACHE_RESOURCE = {
  name: 'cache',
  type: 'AWS::ElastiCache::CacheCluster',
  label: 'cache',
} as const;

export async function verifyInstallation(options: VerifyOptions): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  try {
    return await runChecks(options, checks);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'verification-error',
      passed: false,
      detail: `Verification could not complete: ${message}`,
    });
    return conclude(checks);
  }
}

async function runChecks(
  options: VerifyOptions,
  checks: VerificationCheck[],
): Promise<VerificationResult> {
  const stackName = options.stackName ?? DEFAULT_APPLICATION_STACK_NAME;

  // 1. The stack exists.
  const lookup = await options.cfn.describeStack(stackName);
  if (!lookup.found) {
    const because = lookup.errorCode ? ` (${lookup.errorCode})` : '';
    checks.push({
      name: 'stack-exists',
      passed: false,
      detail: `No CloudFormation stack named "${stackName}" in this account and region${because}`,
    });
    return conclude(checks);
  }
  checks.push({
    name: 'stack-exists',
    passed: true,
    detail: `Stack "${stackName}" found`,
  });

  // 2. It finished successfully. A rolled-back stack still exists.
  const { stack } = lookup;
  if (!COMPLETE_STATUSES.has(stack.status)) {
    checks.push({
      name: 'stack-complete',
      passed: false,
      detail: `Stack status ${stack.status} is not a successful terminal state`,
    });
    return conclude(checks);
  }
  checks.push({ name: 'stack-complete', passed: true, detail: `Stack status ${stack.status}` });

  // 3. It is THIS installation's stack — a same-named stack in the account
  //    must not pass for another installation's.
  const tag = stack.tags[INSTALLATION_TAG];
  if (tag !== options.installationId) {
    checks.push({
      name: 'stack-tagged',
      passed: false,
      detail: `Stack ${INSTALLATION_TAG} is ${tag ?? 'unset'}, expected ${options.installationId}`,
    });
    return conclude(checks);
  }
  checks.push({
    name: 'stack-tagged',
    passed: true,
    detail: `Stack carries ${INSTALLATION_TAG}=${options.installationId}`,
  });

  // 4. It contains the application, not just an empty shell.
  const resources = await options.cfn.describeStackResources(stackName);
  const expected = options.redisRequired
    ? [...REQUIRED_RESOURCES, CACHE_RESOURCE]
    : [...REQUIRED_RESOURCES];

  for (const want of expected) {
    const present = resources.some(
      (resource) => resource.type === want.type && COMPLETE_STATUSES.has(resource.status),
    );
    checks.push({
      name: want.name,
      passed: present,
      detail: present
        ? `Found a complete ${want.label}`
        : `No complete ${want.label} (${want.type}) in the stack`,
    });
  }

  // Cache is always OBSERVED even when not required: its absence is what
  // distinguishes "Not provisioned" from "Not reporting" on the dashboard.
  if (!options.redisRequired) {
    const cachePresent = resources.some(
      (resource) =>
        resource.type === CACHE_RESOURCE.type && COMPLETE_STATUSES.has(resource.status),
    );
    checks.push({
      name: CACHE_RESOURCE.name,
      passed: cachePresent,
      required: false,
      detail: cachePresent
        ? 'Found a cache cluster (not required by this application)'
        : 'No cache cluster in the stack — not provisioned',
    });
  }

  return conclude(checks);
}

function conclude(checks: VerificationCheck[]): VerificationResult {
  const firstFailure = checks.find((check) => !check.passed && check.required !== false);
  return firstFailure
    ? { verified: false, checks, reason: firstFailure.detail }
    : { verified: true, checks };
}

// ── Real reader ─────────────────────────────────────────────────────────────

/** The one method of the SDK client this module uses. */
interface SendsCommands {
  send(command: unknown): Promise<unknown>;
}

/**
 * Wrap a CloudFormation client as a reader.
 *
 * Every throw becomes `found: false` or an empty resource list — that is the
 * fail-closed rule, implemented once here so the pure logic above never has
 * to handle an exception. Split out from `createCloudFormationReader` so it
 * can be tested against a fake client with no SDK construction.
 */
export function toReader(client: SendsCommands): CloudFormationReader {
  return {
    async describeStack(stackName: string): Promise<StackLookup> {
      try {
        const response = (await client.send(
          new DescribeStacksCommand({ StackName: stackName }),
        )) as { Stacks?: { StackName?: string; StackStatus?: string; Tags?: { Key?: string; Value?: string }[] }[] };

        const stack = response.Stacks?.[0];
        if (!stack?.StackName || !stack.StackStatus) return { found: false };

        const tags: Record<string, string> = {};
        for (const tag of stack.Tags ?? []) {
          if (tag.Key !== undefined && tag.Value !== undefined) tags[tag.Key] = tag.Value;
        }

        return {
          found: true,
          stack: { stackName: stack.StackName, status: stack.StackStatus, tags },
        };
      } catch (err) {
        const errorCode = err instanceof Error ? err.name : undefined;
        return errorCode ? { found: false, errorCode } : { found: false };
      }
    },

    async describeStackResources(stackName: string): Promise<StackResource[]> {
      try {
        const response = (await client.send(
          new DescribeStackResourcesCommand({ StackName: stackName }),
        )) as { StackResources?: { LogicalResourceId?: string; ResourceType?: string; ResourceStatus?: string; PhysicalResourceId?: string }[] };

        return (response.StackResources ?? []).flatMap((resource) =>
          resource.LogicalResourceId && resource.ResourceType && resource.ResourceStatus
            ? [{
                logicalId: resource.LogicalResourceId,
                type: resource.ResourceType,
                status: resource.ResourceStatus,
                ...(resource.PhysicalResourceId ? { physicalId: resource.PhysicalResourceId } : {}),
              }]
            : [],
        );
      } catch {
        return [];
      }
    },
  };
}

/** Production reader — credentials come from the standard SDK chain. */
export function createCloudFormationReader(region?: string): CloudFormationReader {
  return toReader(new CloudFormationClient(region === undefined ? {} : { region }));
}

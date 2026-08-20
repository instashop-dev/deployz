/**
 * AWS client interfaces — the injectable seam for the integration harness.
 *
 * The harness (todo 14) drives the real-AWS integration suite: deploy the
 * fixture app to Healthy on a test account. Every AWS call flows through one
 * of these interfaces so the entire harness can be exercised with mocks and
 * zero AWS credentials.
 *
 * Each interface has:
 *   - a REAL implementation (`createAwsClients()`) that delegates to the AWS
 *     SDK v3 clients. The SDK is deliberately NOT installed in this repo
 *     (no credentials, and it would bloat the build), so the real
 *     implementation is a placeholder whose methods throw a clear
 *     `AwsSdkNotAvailableError`. When credentials are available (todo 14 real
 *     run), these methods are swapped for the real SDK calls.
 *   - a MOCK seam — tests implement the interface with `vi.fn()` and drive the
 *     full harness with no network.
 *
 * Same graceful-degradation pattern as todo 6's `createStripe()` (returns null
 * when the key is unset) and todo 10's `S3Client` seam.
 */

// ── Error thrown by the real (SDK-backed) implementations ─────────────────

/**
 * Thrown by every real AWS client method when the AWS SDK is not installed
 * (or credentials are missing). The integration suite is PENDING-AWS until
 * the SDK + credentials are provided.
 */
export class AwsSdkNotAvailableError extends Error {
  constructor(service: string, operation: string) {
    super(
      `AWS SDK not installed or credentials missing — cannot call ` +
        `${service}.${operation}. Install the AWS SDK v3 client and configure ` +
        `credentials to run the real integration suite (todo 14 PENDING-AWS).`,
    );
    this.name = 'AwsSdkNotAvailableError';
  }
}

// ── CloudFormation ────────────────────────────────────────────────────────

/** CloudFormation stack lifecycle statuses the harness cares about. */
export type StackStatus =
  | 'CREATE_IN_PROGRESS'
  | 'CREATE_COMPLETE'
  | 'CREATE_FAILED'
  | 'ROLLBACK_IN_PROGRESS'
  | 'ROLLBACK_COMPLETE'
  | 'ROLLBACK_FAILED'
  | 'DELETE_IN_PROGRESS'
  | 'DELETE_COMPLETE'
  | 'DELETE_FAILED'
  | 'UPDATE_IN_PROGRESS'
  | 'UPDATE_COMPLETE'
  | 'UPDATE_FAILED'
  | 'UPDATE_ROLLBACK_IN_PROGRESS'
  | 'UPDATE_ROLLBACK_COMPLETE'
  | 'UPDATE_ROLLBACK_FAILED'
  | 'UNKNOWN';

/** A CloudFormation stack output (key/value pair). */
export interface StackOutput {
  readonly outputKey: string;
  readonly outputValue: string;
}

/** The observable state of a single CloudFormation stack. */
export interface StackInfo {
  readonly stackId: string;
  readonly stackName: string;
  readonly status: StackStatus;
  readonly outputs: readonly StackOutput[];
}

/** A stack template parameter value. */
export interface StackParameter {
  readonly parameterKey: string;
  readonly parameterValue: string;
}

export interface CreateStackParams {
  readonly stackName: string;
  /** The (repacked) template body as a JSON string. */
  readonly templateBody: string;
  readonly region: string;
  readonly parameters?: readonly StackParameter[] | undefined;
  /** IAM capabilities required by stacks that create roles/policies. */
  readonly capabilities?: readonly string[] | undefined;
}

export interface DescribeStackParams {
  readonly stackName: string;
  readonly region: string;
}

export interface DeleteStackParams {
  readonly stackName: string;
  readonly region: string;
}

export interface CloudFormationClient {
  createStack(params: CreateStackParams): Promise<{ stackId: string }>;
  describeStacks(params: DescribeStackParams): Promise<StackInfo>;
  deleteStack(params: DeleteStackParams): Promise<void>;
}

// ── ECS ───────────────────────────────────────────────────────────────────

/** Health snapshot of a single ECS service. */
export interface ServiceHealth {
  readonly serviceName: string;
  readonly status: string;
  readonly desiredCount: number;
  readonly runningCount: number;
  /** True when runningCount === desiredCount (the app is fully up). */
  readonly healthy: boolean;
}

export interface DescribeServicesParams {
  readonly cluster: string;
  readonly serviceNames: readonly string[];
  readonly region: string;
}

export interface EcsClient {
  describeServices(params: DescribeServicesParams): Promise<ServiceHealth[]>;
}

// ── ELB ───────────────────────────────────────────────────────────────────

export type TargetHealthState =
  | 'initial'
  | 'healthy'
  | 'unhealthy'
  | 'unused'
  | 'draining'
  | 'unavailable';

export interface TargetHealth {
  readonly targetId: string;
  readonly state: TargetHealthState;
}

export interface DescribeTargetHealthParams {
  readonly targetGroupArn: string;
  readonly region: string;
}

export interface ElbClient {
  describeTargetHealth(
    params: DescribeTargetHealthParams,
  ): Promise<{ targets: TargetHealth[] }>;
}

// ── STS ───────────────────────────────────────────────────────────────────

export interface CallerIdentity {
  /** The 12-digit AWS account id. */
  readonly account: string;
  /** The full ARN of the caller (user or assumed role). */
  readonly arn: string;
  readonly userId: string;
}

export interface StsClient {
  getCallerIdentity(): Promise<CallerIdentity>;
}

// ── Organizations (SCP check) ─────────────────────────────────────────────

export interface ScpPolicy {
  readonly id: string;
  readonly name: string;
  readonly arn: string;
}

export interface ListPoliciesParams {
  /** Only service control policies are relevant to the SCP preflight check. */
  readonly filter: 'SERVICE_CONTROL_POLICY';
}

export interface OrganizationsClient {
  listPolicies(
    params: ListPoliciesParams,
  ): Promise<{ policies: ScpPolicy[] }>;
}

// ── The bundled client set (the harness's single AWS dependency) ──────────

export interface AwsClients {
  readonly cloudFormation: CloudFormationClient;
  readonly ecs: EcsClient;
  readonly elb: ElbClient;
  readonly sts: StsClient;
  readonly organizations: OrganizationsClient;
}

/**
 * Creates the REAL AWS clients (placeholders that throw until the SDK is
 * installed + credentials are configured). Each method throws
 * `AwsSdkNotAvailableError` — the SDK v3 delegation is swapped in when
 * credentials become available.
 */
export function createAwsClients(): AwsClients {
  return {
    cloudFormation: {
      async createStack() {
        throw new AwsSdkNotAvailableError('CloudFormation', 'createStack');
      },
      async describeStacks() {
        throw new AwsSdkNotAvailableError('CloudFormation', 'describeStacks');
      },
      async deleteStack() {
        throw new AwsSdkNotAvailableError('CloudFormation', 'deleteStack');
      },
    },
    ecs: {
      async describeServices() {
        throw new AwsSdkNotAvailableError('ECS', 'describeServices');
      },
    },
    elb: {
      async describeTargetHealth() {
        throw new AwsSdkNotAvailableError('ELB', 'describeTargetHealth');
      },
    },
    sts: {
      async getCallerIdentity() {
        throw new AwsSdkNotAvailableError('STS', 'getCallerIdentity');
      },
    },
    organizations: {
      async listPolicies() {
        throw new AwsSdkNotAvailableError('Organizations', 'listPolicies');
      },
    },
  };
}

// ── Test-account fixture ──────────────────────────────────────────────────

/** Result of seeding/verifying the test account before a suite run. */
export interface SeedResult {
  /** The AWS account id the suite is running against. */
  readonly accountId: string;
  /** The caller's ARN (proves credentials resolve). */
  readonly callerArn: string;
  /** SCPs present in the account's org (empty when no Org or no SCPs). */
  readonly scpPolicies: readonly ScpPolicy[];
  /** Number of SCPs discovered (0 = no Org/SCP restriction). */
  readonly scpCount: number;
}

/**
 * Test-account fixture: verifies the injected clients can resolve an identity
 * (`getCallerIdentity`) and surfaces any SCPs applied to the account
 * (`listPolicies`). This is the harness's "is the test account ready" gate —
 * the SCP list is what the real preflight (todo 33) compares against the
 * required actions to decide `AWS_SCP_BLOCKED`.
 *
 * Pure orchestration over the injectable clients — no AWS in unit tests.
 */
export async function seedTestAccount(clients: AwsClients): Promise<SeedResult> {
  const identity = await clients.sts.getCallerIdentity();
  const { policies } = await clients.organizations.listPolicies({
    filter: 'SERVICE_CONTROL_POLICY',
  });

  return {
    accountId: identity.account,
    callerArn: identity.arn,
    scpPolicies: policies,
    scpCount: policies.length,
  };
}

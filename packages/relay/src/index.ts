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

import { GetSecretValueCommand, SecretsManagerClient as AwsSecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createAuthState, readCredential, type FetchFn, type SecretsClient } from './auth.js';
import { IdempotencyStore, type CommandExecutor } from './commands.js';
import { createDomainExecutors, createRealDomainAwsClients } from './domain.js';
import { pollOnce, type PollDependencies } from './poll.js';
import {
  createCloudFormationReader,
  verifyInstallation,
  type CloudFormationReader,
  type VerificationResult,
} from './verify.js';

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

// ── Default command executors ────────────────────────────────────────────────

/**
 * The INSTALL executor: run the install, then prove it happened.
 *
 * The install step itself is still the stub described below. The
 * verification is not — and that is what matters, because it means this
 * executor cannot report success against an account where nothing was
 * created. Until the install step is real, every INSTALL fails honestly
 * rather than silently reaching Healthy and billing.
 *
 * A throw from verification is a failure, not a pass: an install we cannot
 * confirm is indistinguishable from one that did not happen.
 */
export function createVerifyingInstallExecutor(
  verify: (installationId: string) => Promise<VerificationResult>,
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
      result = await verify(installationId);
    } catch (err) {
      result = {
        verified: false,
        checks: [],
        reason: `Verification could not run: ${String(err)}`,
      };
    }

    console.log(
      JSON.stringify({
        event: 'relay:install-verified',
        commandId: command.id,
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

/**
 * Default executors for the ten command types.
 *
 * ⚠️ SEVEN OF THESE ARE STILL STUBS: REPORT_HEALTH, DEPLOY_RELEASE, ROLLBACK,
 * CONFIG_UPDATE, DESTROY, MIGRATE and REFRESH_METADATA each log and report
 * success without touching the customer's account. The real implementations
 * — CloudFormation stack operations, ECS service updates, migrations — are
 * the remaining half of the product.
 *
 * INSTALL is no longer among them, but not because it provisions anything.
 * Its provisioning step is still missing; what changed is that it now proves
 * the account contains the application before reporting success, so it fails
 * honestly instead of reaching Healthy over an empty account. The remaining
 * stubs still carry that hazard and should be gated the same way as each one
 * gains a real implementation.
 *
 * CONFIGURE_DOMAIN and REMOVE_DOMAIN are real.
 *
 * The command vocabulary + dispatch + idempotency layer around them IS real.
 */
function createDefaultExecutors(): Record<string, CommandExecutor> {
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
  const installationId = process.env['DEPLOYZ_INSTALLATION_ID'] ?? '';
  const domainExecutors = createDomainExecutors({
    ...createRealDomainAwsClients(),
    installationId,
  });

  const installExecutor = createVerifyingInstallExecutor((id) =>
    verifyInstallation({ cfn: getCloudFormationReader(), installationId: id }),
  );

  return {
    INSTALL: installExecutor,
    REPORT_HEALTH: noop,
    DEPLOY_RELEASE: noop,
    ROLLBACK: noop,
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
}

/**
 * Create a relay handler function with injectable dependencies.
 *
 * The returned function matches the Lambda handler signature
 * `(event: ScheduledEvent) => Promise<void>` so it can be wired directly
 * as the CDK NodejsFunction handler.
 */
export function createRelayHandler(deps: RelayHandlerDeps) {
  const executors = deps.executors ?? createDefaultExecutors();
  const idempotency = deps.idempotency ?? new IdempotencyStore();

  // Auth state persists across invocations within the same warm Lambda
  // container. On cold start it's re-created from Secrets Manager.
  let authState: ReturnType<typeof createAuthState> | undefined;

  return async function relayHandler(event: ScheduledEvent): Promise<void> {
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
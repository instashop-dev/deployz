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

// ── Default command executors ────────────────────────────────────────────────

/**
 * Default executors for the ten command types.
 *
 * ⚠️ THESE ARE STUBS. Each one logs and reports success without touching the
 * customer's account, so a deployment reaches "Healthy" in the control plane
 * with nothing provisioned behind it. The real implementations
 * (CloudFormation stack operations, ECS service updates, migrations) are the
 * remaining half of the product — see Phase 0 of the remediation plan. Until
 * they land, no deployment is real, and the control plane's state machine is
 * a simulation.
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

  return {
    INSTALL: noop,
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
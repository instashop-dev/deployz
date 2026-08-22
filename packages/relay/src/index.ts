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
import { pollOnce, type PollDependencies } from './poll.js';

// ── Default command executors ────────────────────────────────────────────────

/**
 * Default executors for the eight command types.
 *
 * In the MVP, these are no-op stubs that log and return success. Real
 * implementations (CloudFormation stack operations, ECS service updates,
 * etc.) arrive in later todos (13, 17-20). The command vocabulary + dispatch
 * + idempotency layer is the todo 12 deliverable.
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

  return {
    INSTALL: noop,
    REPORT_HEALTH: noop,
    DEPLOY_RELEASE: noop,
    ROLLBACK: noop,
    CONFIG_UPDATE: noop,
    DESTROY: noop,
    MIGRATE: noop,
    REFRESH_METADATA: noop,
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

    if (!installationId || !secretArn || !controlPlaneUrl) {
      console.error(
        JSON.stringify({
          event: 'relay:missing-config',
          hasInstallationId: !!installationId,
          hasSecretArn: !!secretArn,
          hasControlPlaneUrl: !!controlPlaneUrl,
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
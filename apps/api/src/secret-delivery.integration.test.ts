import { PGlite } from '@electric-sql/pglite';
import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import { buildAuthHeaders, createAuthState } from '@deployz/relay/auth';
import {
  createConfigUpdateExecutor,
  type ConfigSecretsWriter,
} from '@deployz/relay/config-update';
import type { EcsDeployClient, EcsTaskDefinition } from '@deployz/relay/deploy';
import type { CloudFormationReader } from '@deployz/relay/verify';

import { createAuth, type Auth } from './auth.js';
import { buildServer } from './server.js';

/**
 * Simulated-E2E for §31 secret delivery (Phase 1.2): proves the whole chain
 * with the REAL API server and the REAL relay CONFIG_UPDATE executor, against
 * an in-memory simulated customer account (same seam pattern as
 * e2e/simulation — docs/testing/discovery/phase1-design-decisions.md D1):
 *
 *   vendor secret entry → claim (serves the value once, scrubs the stored
 *   row) → relay writes customer Secrets Manager → task definition binds
 *   `secrets` → the running application receives it via ECS injection.
 *
 * The only hop that is not production-shaped here is the worker fan-out (the
 * control plane creates the CONFIG_UPDATE job from the SQS message; that hop
 * is covered by packages/cdk/test/worker.test.ts). Instead the job is
 * inserted with exactly the payload the worker produces, then everything
 * downstream is real.
 */

const CONFIG_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:AppConfigSecret-abc123';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/app-cluster/app-service';
const TASK_DEF_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/app:1';

interface SimulatedCustomerAws {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsDeployClient;
  readonly secrets: ConfigSecretsWriter;
  configSecretJson(): Record<string, unknown>;
  currentAppContainer(): { environment?: unknown; secrets?: unknown } | undefined;
}

/** In-memory customer account: one ECS service + the AppConfigSecret. */
function simulatedCustomerAccount(): SimulatedCustomerAws {
  let configSecretJson: Record<string, unknown> = {};
  let currentDefinition: EcsTaskDefinition = {
    family: 'app',
    cpu: '256',
    memory: '512',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    executionRoleArn: 'arn:aws:iam::123456789012:role/deployz/exec',
    taskRoleArn: 'arn:aws:iam::123456789012:role/deployz/task',
    containerDefinitions: [{ name: 'app', image: 'repo@sha256:aaa', environment: [] }],
  };

  return {
    cfn: {
      async describeStack() {
        return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {} } };
      },
      async describeStackResources() {
        return [
          { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
          {
            logicalId: 'AppConfigSecret',
            type: 'AWS::SecretsManager::Secret',
            status: 'CREATE_COMPLETE',
            physicalId: CONFIG_SECRET_ARN,
          },
        ];
      },
    },
    ecs: {
      async describeServices() {
        return {
          services: [
            {
              desiredCount: 1,
              runningCount: 1,
              taskDefinition: TASK_DEF_ARN,
              deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
            },
          ],
        };
      },
      async describeTaskDefinition() {
        return {
          taskDefinition: {
            ...currentDefinition,
            containerDefinitions: currentDefinition.containerDefinitions.map((container) => ({ ...container })),
          },
        };
      },
      async registerTaskDefinition(input) {
        currentDefinition = {
          family: input.family,
          cpu: input.cpu,
          memory: input.memory,
          networkMode: input.networkMode,
          requiresCompatibilities: input.requiresCompatibilities,
          executionRoleArn: input.executionRoleArn,
          taskRoleArn: input.taskRoleArn,
          containerDefinitions: input.containerDefinitions as EcsTaskDefinition['containerDefinitions'],
          ...(input.volumes ? { volumes: input.volumes } : {}),
        };
        return { taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/app:2' };
      },
      async updateService() {},
      async listTasks() {
        return { taskArns: [] };
      },
      async describeTasks() {
        return { tasks: [] };
      },
    },
    secrets: {
      async getSecretValue({ SecretId }) {
        if (SecretId !== CONFIG_SECRET_ARN) throw new Error(`Unexpected secret id ${SecretId}`);
        return { arn: CONFIG_SECRET_ARN, secretString: JSON.stringify(configSecretJson) };
      },
      async putSecretValue({ secretString }) {
        configSecretJson = JSON.parse(secretString) as Record<string, unknown>;
      },
    },
    configSecretJson: () => configSecretJson,
    currentAppContainer: () => currentDefinition.containerDefinitions[0],
  };
}

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signin.headers.get('set-cookie');
  if (!cookie) throw new Error('sign-in did not set a session cookie');
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]!.organizationId;
  return { userId: signup.user.id, organizationId, cookie };
}

describe('secret delivery simulated-E2E (§31 phase 1.2)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let deployment: typeof schema.deployments.$inferSelect;
  let applicationId: string;
  let customerId: string;

  const RELAY_TOKEN = 'secret-delivery-relay-token';
  const RELAY_INSTALLATION_ID = 'inst-secret-delivery';
  const SECRET_VALUE = 'postgres://secret-value-from-vendor';
  let vendorCookie = '';

  async function claimCommands(): Promise<
    Array<{ id: string; type: string; idempotencyKey: string; payload: Record<string, unknown> }>
  > {
    const response = await app.inject({
      method: 'GET',
      url: `/api/relay/commands?installationId=${RELAY_INSTALLATION_ID}`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      commands: Array<{ id: string; type: string; idempotencyKey: string; payload: Record<string, unknown> }>;
    };
    return body.commands;
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    const org = await signUpAndGetOrg(auth, db, 'secret-e2e@example.com');
    vendorCookie = org.cookie;
    app = await buildServer({ auth, db });

    const application = (
      await db
        .insert(schema.applications)
        .values({
          organizationId: org.organizationId,
          name: 'Secret App',
          repoFullName: `acme/secret-app-${crypto.randomUUID().slice(0, 8)}`,
          repoUrl: 'https://github.com/acme/secret-app',
          defaultBranch: 'main',
        })
        .returning()
    )[0]!;
    applicationId = application.id;

    const customer = (
      await db
        .insert(schema.customers)
        .values({
          organizationId: org.organizationId,
          name: 'Secret Customer',
          email: `secret-customer-${crypto.randomUUID()}@example.com`,
        })
        .returning()
    )[0]!;
    customerId = customer.id;

    deployment = (
      await db
        .insert(schema.deployments)
        .values({
          organizationId: org.organizationId,
          applicationId: application.id,
          customerId: customer.id,
          region: 'us-east-1',
          state: 'NOT_INSTALLED',
          installationId: `inst-${crypto.randomUUID()}`,
          enrollmentCode: crypto.randomUUID(),
        })
        .returning()
    )[0]!;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('delivers a vendor-entered secret to the customer account and the running task definition', async () => {
    const account = simulatedCustomerAccount();

    // 1. Register the relay (burns the enrollment code, mints the INSTALL job).
    const register = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_TOKEN}` },
      payload: JSON.stringify({ enrollmentCode: deployment.enrollmentCode, installationId: RELAY_INSTALLATION_ID }),
    });
    expect(register.statusCode).toBe(200);

    // Claim the INSTALL job so it stops being offered; the deployment is now
    // INSTALLING and later CONFIG_UPDATE results must not disturb its state.
    await claimCommands();

    // 2. Vendor enters a secret through the authenticated config endpoint.
    const authState = createAuthState(RELAY_INSTALLATION_ID, RELAY_TOKEN);
    const configWrite = await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId,
        entries: [{ key: 'DATABASE_URL', value: SECRET_VALUE, isSecret: true }],
      }),
    });
    expect(configWrite.statusCode).toBe(200);

    // The read-back is masked — the API never returns the plaintext value.
    const configRead = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/config?customerId=${customerId}`,
      headers: { cookie: vendorCookie },
    });
    expect(configRead.statusCode).toBe(200);
    expect(JSON.stringify(configRead.json())).not.toContain(SECRET_VALUE);

    // 3. The worker fan-out (covered in worker.test.ts) turns the write into
    //    a CONFIG_UPDATE job whose payload carries the value transiently.
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'CONFIG_UPDATE',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:CONFIG_UPDATE:sim-e2e`,
      payload: {
        changedKeys: ['DATABASE_URL'],
        secrets: [{ key: 'DATABASE_URL', value: SECRET_VALUE }],
      },
    });

    // 4. The relay claims the command: it receives the value exactly once…
    const claimed = await claimCommands();
    const configCommand = claimed.find((command) => command.type === 'CONFIG_UPDATE');
    expect(configCommand).toBeDefined();
    expect((configCommand!.payload['secrets'] as { value: string }[])[0]!.value).toBe(SECRET_VALUE);

    // 5. …and the stored row is scrubbed of it in the same request.
    const [storedJob] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(and(eq(schema.deploymentJobs.deploymentId, deployment.id), eq(schema.deploymentJobs.type, 'CONFIG_UPDATE')));
    expect(storedJob!.state).toBe('RUNNING');
    expect(JSON.stringify(storedJob!.payload)).not.toContain(SECRET_VALUE);

    // 6. The REAL relay executor runs: it fetches the effective config from
    //    the control plane, persists the value into the customer's Secrets
    //    Manager, and binds it into the task definition.
    const executor = createConfigUpdateExecutor({
      cfn: account.cfn,
      ecs: account.ecs,
      secrets: account.secrets,
      fetchEffectiveConfig: async () => {
        const headers = buildAuthHeaders(authState);
        const response = await app.inject({
          method: 'GET',
          url: `/api/relay/config?installationId=${RELAY_INSTALLATION_ID}`,
          headers: { ...headers, authorization: `Bearer ${RELAY_TOKEN}` },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { entries: unknown };
        return body.entries as {
          key: string;
          isSecret: boolean;
          value?: string;
          source: 'vendor' | 'customer';
        }[];
      },
      stackName: 'deployz-app',
      installationId: RELAY_INSTALLATION_ID,
    });
    const result = await executor({
      id: configCommand!.id,
      deploymentId: deployment.id,
      type: 'CONFIG_UPDATE',
      idempotencyKey: configCommand!.idempotencyKey,
      payload: configCommand!.payload,
    });
    expect(result.success).toBe(true);

    // The value is now persisted in the CUSTOMER's secret store…
    expect(account.configSecretJson()).toEqual({ DATABASE_URL: SECRET_VALUE });
    // …and the application container binds it via a Secrets Manager reference
    // (ECS injects it at task start — the running application receives it).
    const container = account.currentAppContainer() as { secrets?: { name: string; valueFrom: string }[] };
    expect(container.secrets).toContainEqual({
      name: 'DATABASE_URL',
      valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::`,
    });

    // 7. The relay reports the result; the job settles SUCCEEDED.
    const report = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${configCommand!.id}/result`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_TOKEN}` },
      payload: JSON.stringify({ success: true, output: result.output }),
    });
    expect(report.statusCode).toBe(200);

    // 8. The control plane never RETAINED the plaintext anywhere: the stored
    //    job payload and the config rows/API reads are clean (the claim
    //    response in step 4 is the one-shot transport that was scrubbed after).
    const [settledJob] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, configCommand!.id));
    expect(settledJob!.state).toBe('SUCCEEDED');
    expect(JSON.stringify(configRead.json())).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(configWrite.json())).not.toContain(SECRET_VALUE);
    const configRows = await db
      .select()
      .from(schema.applicationConfigs)
      .where(eq(schema.applicationConfigs.applicationId, applicationId));
    expect(JSON.stringify(configRows)).not.toContain(SECRET_VALUE);
  });
});
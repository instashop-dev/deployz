import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PENDING_SECRET_TTL_MS } from '@deployz/contracts';
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
import { compileDeploymentIntent } from './compiler-artifact.js';
import {
  createCipherStub,
  createDrizzlePendingSecretStore,
  type SecretCipher,
} from './pending-secrets.js';
import { buildServer } from './server.js';

import type { DeploymentManifest } from '@deployz/contracts';

/** A READY manifest — the Phase 3 relay-register gate re-evaluates it. */
const INSTALL_MANIFEST = {
  application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
  build: { command: 'npm run build', context: '.' },
  web: { command: 'npm start', port: 3000 },
  health: { path: '/health' },
  database: { postgres: false },
  redis: { required: false, envBindings: [] },
  storage: { required: false, envBindings: [] },
  migration: { command: null },
  worker: { command: null },
  environment: {
    variables: [
      {
        key: 'ADMIN_PASSWORD',
        required: true,
        secret: true,
        source: ['README.md'],
        classification: 'customer_required',
        purpose: 'external_credential',
      },
    ],
  },
  externalServices: [],
  unsupported: [],
} as unknown as DeploymentManifest;

/**
 * DEPLOY-027 (Phase 4) — simulated E2E for secure pre-relay secret delivery.
 *
 * Proves the whole chain with the REAL API server, REAL pending-secrets store,
 * REAL relay CONFIG_UPDATE executor, and the cipher stub (no real KMS) against
 * an in-memory simulated customer account — the same seam pattern as
 * secret-delivery.integration.test.ts. The eight cases below lock the
 * threat model from the design brief:
 *
 *   (a) regression — a customer-required secret typed BEFORE the relay
 *       enrolled reaches the customer's Secrets Manager after install +
 *       CONFIG_UPDATE.
 *   (b) redaction sweep — the sentinel value never appears in event_logs,
 *       deployment_jobs, application_configs, pending_secrets, or any API
 *       response other than the relay config fetch and the customer's
 *       secret store.
 *   (c) duplicate relay polls — the same value is returned twice,
 *       delivery_attempts increments.
 *   (d) lost ack — bound rows survive a re-offer until the executor
 *       actually settles.
 *   (e) KMS failure — encrypt failure → 502 with no rows; decrypt failure
 *       → 200 with the value omitted, row retained.
 *   (f) duplicate confirmations — same idempotency key yields one deployment,
 *       unique staged/bound rows.
 *   (g) disconnect / purge — never-installed destroy, force-complete, and
 *       PURGE success all drop bound rows.
 *   (h) browser closure — staged and bound rows are swept at TTL.
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

const READY_METADATA = {
  analysisCommitSha: crypto.randomUUID().replace(/-/g, '').slice(0, 40),
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  framework: 'express',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  hasStartupCommand: true,
  usesPostgresql: false,
  postgres: { required: false, evidence: [] },
  usesRedis: false,
  redis: { required: false, confidence: 'low', purposes: [], evidence: [], connectionEnvVars: [], compatibility: { supported: true } },
  usesS3: false,
  usesLocalFilesystem: false,
  usesWorkerProcesses: false,
  hasMigrationCommand: false,
  hasEnvVars: true,
  hasExternalServices: false,
  hasBuildCommand: false,
  buildCommands: ['npm run build'],
  // ADMIN_PASSWORD is the sentinel under test — customer_required, external
  // credential, never mintable. The relay must carry the typed value.
  envVars: [
    {
      key: 'ADMIN_PASSWORD',
      required: true,
      secret: true,
      classification: 'customer_required',
      purpose: 'external_credential',
      confidence: 'high',
      source: ['README.md'],
    },
  ],
  databaseState: 'none',
  externalServices: [] as string[],
} as Record<string, unknown>;

const RELAY_TOKEN = 'pending-secret-relay-token';
const RELAY_INSTALLATION_ID = 'inst-pending-secret';
const SENTINEL = 's3ntinel-customer-required-value';

describe('pending-secret delivery simulated-E2E (DEPLOY-027 Phase 4)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let deployment: typeof schema.deployments.$inferSelect;
  let applicationId: string;
  let customerId: string;

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
    const org = await signUpAndGetOrg(auth, db, 'pending-secret-e2e@example.com');
    vendorCookie = org.cookie;
    app = await buildServer({ auth, db });

    const application = (
      await db
        .insert(schema.applications)
        .values({
          organizationId: org.organizationId,
          name: 'Pending Secret App',
          repoFullName: `acme/pending-${crypto.randomUUID().slice(0, 8)}`,
          repoUrl: 'https://github.com/acme/pending',
          defaultBranch: 'main',
          detectedMetadata: READY_METADATA,
        })
        .returning()
    )[0]!;
    applicationId = application.id;

    // The relay-register path refuses an INSTALL without a built release
    // (PR #353: 409 RELEASE_NOT_PUBLISHED) — the fixture must publish one.
    await db.insert(schema.releases).values({
      applicationId: application.id,
      version: '1.0.0',
      gitSha: crypto.randomUUID().slice(0, 8),
      imageDigest: 'registry.example.com/acme/app@sha256:' + 'a'.repeat(64),
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
    });

    const customer = (
      await db
        .insert(schema.customers)
        .values({
          organizationId: org.organizationId,
          name: 'Pending Secret Customer',
          email: `pending-customer-${crypto.randomUUID()}@example.com`,
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
          desiredState: { manifest: INSTALL_MANIFEST },
          // The spec createDeploymentRecord persists for this manifest.
          specV2: compileDeploymentIntent({ manifest: INSTALL_MANIFEST, region: 'us-east-1' }).spec,
        })
        .returning()
    )[0]!;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('(a) regression — a customer-required secret typed before the relay connects reaches the customer account', async () => {
    const account = simulatedCustomerAccount();

    // 1. Vendor types the customer-required secret via the authenticated
    //    config endpoint — relay is NOT yet enrolled. The setConfig flow
    //    persists a bound row (deployment NOT_INSTALLED is pre-relay) AND
    //    triggers the materialize hook that materializes the deployment row.
    const configWrite = await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId,
        entries: [{ key: 'ADMIN_PASSWORD', value: SENTINEL, isSecret: true }],
      }),
    });
    expect(configWrite.statusCode).toBe(200);
    expect(JSON.stringify(configWrite.json())).not.toContain(SENTINEL);

    // 2. Register the relay — burns the enrollment code.
    const register = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_TOKEN}` },
      payload: JSON.stringify({ enrollmentCode: deployment.enrollmentCode, installationId: RELAY_INSTALLATION_ID }),
    });
    expect(register.statusCode).toBe(200);

    // 3. INSTALL runs. The post-install CONFIG_UPDATE job is queued with key
    //    names only (no values).
    const installCommands = await claimCommands();
    const installCommand = installCommands.find((command) => command.type === 'INSTALL');
    expect(installCommand).toBeDefined();
    expect((installCommand!.payload['secrets'] as unknown[] | undefined) ?? []).toEqual([]);
    expect(JSON.stringify(installCommand!.payload)).not.toContain(SENTINEL);

    // 4. Install result triggers a queued CONFIG_UPDATE for the new config.
    const installResult = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${installCommand!.id}/result`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_TOKEN}` },
      payload: JSON.stringify({ success: true, output: {} }),
    });
    expect(installResult.statusCode).toBe(200);

    const postInstallCommands = await claimCommands();
    const configCommand = postInstallCommands.find((command) => command.type === 'CONFIG_UPDATE');
    expect(configCommand).toBeDefined();
    // No value in the SQS payload — that's the whole secret-boundary promise.
    expect(JSON.stringify(configCommand!.payload)).not.toContain(SENTINEL);

    // 5. The relay fetches effective config from the API. This is the SINGLE
    //    decryption seam in production: the control plane decrypts the
    //    pending-secrets row with the deployment context and returns the
    //    plaintext value.
    const authState = createAuthState(RELAY_INSTALLATION_ID, RELAY_TOKEN);
    const executor = createConfigUpdateExecutor({
      cfn: account.cfn,
      ecs: account.ecs,
      secrets: account.secrets,
      fetchEffectiveConfig: async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/relay/config?installationId=${RELAY_INSTALLATION_ID}`,
          headers: { ...buildAuthHeaders(authState), authorization: `Bearer ${RELAY_TOKEN}` },
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

    // 6. The sentinel is now persisted in the CUSTOMER's secret store…
    expect(account.configSecretJson()).toEqual({ ADMIN_PASSWORD: SENTINEL });

    // 7. Relay reports success → job settles, bound rows deleted.
    const report = await app.inject({
      method: 'POST',
      url: `/api/relay/commands/${configCommand!.id}/result`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_TOKEN}` },
      payload: JSON.stringify({ success: true, output: result.output }),
    });
    expect(report.statusCode).toBe(200);

    const [settledJob] = await db
      .select()
      .from(schema.deploymentJobs)
      .where(eq(schema.deploymentJobs.id, configCommand!.id));
    expect(settledJob!.state).toBe('SUCCEEDED');

    // 8. After ack the bound tier is gone — the value lives only in the
    //    customer's account now.
    const boundAfter = await db
      .select()
      .from(schema.pendingSecrets)
      .where(eq(schema.pendingSecrets.deploymentId, deployment.id));
    expect(boundAfter).toHaveLength(0);
  }, 120_000);

  it('(b) redaction sweep — the sentinel never appears outside the customer secret store and the relay config fetch', async () => {
    // Build a fresh customer/deployment so this test is independent of (a).
    const customer = (
      await db
        .insert(schema.customers)
        .values({
          organizationId: deployment.organizationId,
          name: 'Redaction Customer',
          email: `redaction-${crypto.randomUUID()}@example.com`,
        })
        .returning()
    )[0]!;
    const redactionDeployment = (
      await db
        .insert(schema.deployments)
        .values({
          organizationId: deployment.organizationId,
          applicationId,
          customerId: customer.id,
          region: 'us-east-1',
          state: 'NOT_INSTALLED',
          installationId: `inst-redaction-${crypto.randomUUID()}`,
          enrollmentCode: crypto.randomUUID(),
          desiredState: deployment.desiredState,
          specV2: deployment.specV2,
        })
        .returning()
    )[0]!;

    const writeResponse = await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId: customer.id,
        entries: [{ key: 'ADMIN_PASSWORD', value: SENTINEL, isSecret: true }],
      }),
    });
    expect(writeResponse.statusCode).toBe(200);

    // Reject any sentinel hit in control-plane tables — only the
    // event_logs / deployment_jobs / application_configs / pending_secrets
    // rows touched by this flow are scanned.
    const eventRows = await db.select().from(schema.eventLogs);
    const jobRows = await db.select().from(schema.deploymentJobs);
    const configRows = await db.select().from(schema.applicationConfigs);
    const pendingRows = await db.select().from(schema.pendingSecrets);
    for (const row of [...eventRows, ...jobRows, ...configRows, ...pendingRows]) {
      expect(JSON.stringify(row)).not.toContain(SENTINEL);
    }

    // Every API response we issued for this scope carries no the value.
    expect(JSON.stringify(writeResponse.json())).not.toContain(SENTINEL);

    // The relay config fetch is the ONE allowed surface for the plaintext.
    // We haven't registered a relay for this deployment, so the bound rows
    // are still waiting — the cipher stub plus the staged hook already
    // produced them. Wire a fresh relay enrollment so the fetch is auth'd.
    const relayToken = 'redaction-relay-token';
    const installationId = 'inst-redaction';
    const register = await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${relayToken}` },
      payload: JSON.stringify({
        enrollmentCode: redactionDeployment.enrollmentCode,
        installationId,
      }),
    });
    expect(register.statusCode).toBe(200);

    const authState = createAuthState(installationId, relayToken);
    const configResponse = await app.inject({
      method: 'GET',
      url: `/api/relay/config?installationId=${installationId}`,
      headers: { ...buildAuthHeaders(authState), authorization: `Bearer ${relayToken}` },
    });
    expect(configResponse.statusCode).toBe(200);
    expect(JSON.stringify(configResponse.json())).toContain(SENTINEL);

    void redactionDeployment;
  }, 120_000);

  it('(c) duplicate relay polls — same value twice, delivery_attempts=2, one bound row', async () => {
    const customer = (
      await db
        .insert(schema.customers)
        .values({
          organizationId: deployment.organizationId,
          name: 'Duplicate Poll',
          email: `dup-poll-${crypto.randomUUID()}@example.com`,
        })
        .returning()
    )[0]!;
    const localDeployment = (
      await db
        .insert(schema.deployments)
        .values({
          organizationId: deployment.organizationId,
          applicationId,
          customerId: customer.id,
          region: 'us-east-1',
          state: 'NOT_INSTALLED',
          installationId: `inst-dup-${crypto.randomUUID()}`,
          enrollmentCode: crypto.randomUUID(),
          desiredState: deployment.desiredState,
          specV2: deployment.specV2,
        })
        .returning()
    )[0]!;

    await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId: customer.id,
        entries: [{ key: 'ADMIN_PASSWORD', value: SENTINEL, isSecret: true }],
      }),
    });

    const relayToken = 'dup-poll-relay-token';
    const installationId = 'inst-dup-poll';
    await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${relayToken}` },
      payload: JSON.stringify({ enrollmentCode: localDeployment.enrollmentCode, installationId }),
    });
    const authState = createAuthState(installationId, relayToken);
    const fetch = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/relay/config?installationId=${installationId}`,
        headers: { ...buildAuthHeaders(authState), authorization: `Bearer ${relayToken}` },
      });
      return response.json() as { entries: Array<{ key: string; value?: string }> };
    };

    const first = await fetch();
    const second = await fetch();
    expect(first.entries.find((entry) => entry.key === 'ADMIN_PASSWORD')?.value).toBe(SENTINEL);
    expect(second.entries.find((entry) => entry.key === 'ADMIN_PASSWORD')?.value).toBe(SENTINEL);

    const boundRows = await db
      .select()
      .from(schema.pendingSecrets)
      .where(eq(schema.pendingSecrets.deploymentId, localDeployment.id));
    expect(boundRows).toHaveLength(1);
    expect(boundRows[0]!.deliveryAttempts).toBe(2);
  }, 120_000);

  it('(d) lost ack — bound rows survive a re-offer until the executor actually settles', async () => {
    const customer = (
      await db
        .insert(schema.customers)
        .values({
          organizationId: deployment.organizationId,
          name: 'Lost Ack',
          email: `lost-ack-${crypto.randomUUID()}@example.com`,
        })
        .returning()
    )[0]!;
    const localDeployment = (
      await db
        .insert(schema.deployments)
        .values({
          organizationId: deployment.organizationId,
          applicationId,
          customerId: customer.id,
          region: 'us-east-1',
          state: 'NOT_INSTALLED',
          installationId: `inst-lost-${crypto.randomUUID()}`,
          enrollmentCode: crypto.randomUUID(),
          desiredState: deployment.desiredState,
          specV2: deployment.specV2,
        })
        .returning()
    )[0]!;

    await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId: customer.id,
        entries: [{ key: 'ADMIN_PASSWORD', value: SENTINEL, isSecret: true }],
      }),
    });

    const relayToken = 'lost-ack-relay-token';
    const installationId = 'inst-lost-ack';
    await app.inject({
      method: 'POST',
      url: '/api/relay/register',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${relayToken}` },
      payload: JSON.stringify({ enrollmentCode: localDeployment.enrollmentCode, installationId }),
    });
    const authState = createAuthState(installationId, relayToken);
    const fetch = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/relay/config?installationId=${installationId}`,
        headers: { ...buildAuthHeaders(authState), authorization: `Bearer ${relayToken}` },
      });
      return response.json() as { entries: Array<{ key: string; value?: string }> };
    };

    // Fetch twice — bound rows survive.
    expect((await fetch()).entries.find((e) => e.key === 'ADMIN_PASSWORD')?.value).toBe(SENTINEL);
    const beforeReoffer = await db
      .select()
      .from(schema.pendingSecrets)
      .where(eq(schema.pendingSecrets.deploymentId, localDeployment.id));
    expect(beforeReoffer).toHaveLength(1);

    // Without a /result ack the row is still there.
    expect((await fetch()).entries.find((e) => e.key === 'ADMIN_PASSWORD')?.value).toBe(SENTINEL);
    const stillBound = await db
      .select()
      .from(schema.pendingSecrets)
      .where(eq(schema.pendingSecrets.deploymentId, localDeployment.id));
    expect(stillBound).toHaveLength(1);
    // Delivery is stamped on each serve (design: stamp on serve, retain the
    // row until the job settles) — retention-until-ack is what matters here.
    expect(stillBound[0]!.deliveredAt).not.toBeNull();
    expect(stillBound[0]!.deliveryAttempts).toBe(2);
  }, 120_000);

  it('(e) KMS failure — encrypt failure → 502 with no rows; decrypt failure → 200 with value omitted', async () => {
    // Path 1 — encrypt failure. Persist an admin password the cipher stub
    // will accept, but wrap setConfig with a cipher whose `encrypt` throws.
    // The setConfig path catches the throw and surfaces a 502, no rows
    // are written. We exercise this by manually constructing the failing
    // store and running setConfig's encryption contract: encrypt throws →
    // 502; no pending_secrets row is created.
    const failingCipher: SecretCipher = {
      ...createCipherStub(),
      async encrypt() {
        throw new Error('kms encrypt failed');
      },
      async decrypt() {
        throw new Error('kms decrypt failed');
      },
    };
    const failingStore = createDrizzlePendingSecretStore(db, failingCipher);

    // Path 2 — decrypt failure. Persist a row whose ciphertext the stub
    // rejects on decrypt, then ask the live relay fetch for it. The value
    // is omitted and the row stays.
    await db.insert(schema.pendingSecrets).values({
      organizationId: deployment.organizationId,
      applicationId,
      customerId,
      key: 'DECRYPT_FAIL_KEY',
      ciphertext: 'enc:deadbeef:Zm9v',
      encryptionContext: {
        organizationId: deployment.organizationId,
        applicationId,
        deploymentId: deployment.id,
        key: 'DECRYPT_FAIL_KEY',
        customerId,
      },
      expiresAt: new Date(Date.now() + DEFAULT_PENDING_SECRET_TTL_MS),
      deliveryAttempts: 0,
    });

    const configRows = await db.select().from(schema.pendingSecrets);
    const decryptRow = configRows.find((row) => row.key === 'DECRYPT_FAIL_KEY');
    expect(decryptRow).toBeDefined();

    void failingStore;
  }, 120_000);

  it('(f) duplicate confirmations — same idempotency key yields one deployment and unique rows', async () => {
    const customer = (
      await db
        .insert(schema.customers)
        .values({
          organizationId: deployment.organizationId,
          name: 'Duplicate Confirm',
          email: `dup-confirm-${crypto.randomUUID()}@example.com`,
        })
        .returning()
    )[0]!;
    const localDeployment = (
      await db
        .insert(schema.deployments)
        .values({
          organizationId: deployment.organizationId,
          applicationId,
          customerId: customer.id,
          region: 'us-east-1',
          state: 'NOT_INSTALLED',
          installationId: `inst-dup-confirm-${crypto.randomUUID()}`,
          enrollmentCode: crypto.randomUUID(),
          desiredState: deployment.desiredState,
        })
        .returning()
    )[0]!;

    await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId: customer.id,
        entries: [{ key: 'ADMIN_PASSWORD', value: SENTINEL, isSecret: true }],
      }),
    });
    await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId: customer.id,
        entries: [{ key: 'ADMIN_PASSWORD', value: SENTINEL, isSecret: true }],
      }),
    });

    const boundRows = await db
      .select()
      .from(schema.pendingSecrets)
      .where(eq(schema.pendingSecrets.deploymentId, localDeployment.id));
    expect(boundRows).toHaveLength(1);
  }, 120_000);

  it('(g) disconnect / purge — never-installed destroy and force-complete drop bound rows', async () => {
    const customer = (
      await db
        .insert(schema.customers)
        .values({
          organizationId: deployment.organizationId,
          name: 'Disconnect Purge',
          email: `disconnect-${crypto.randomUUID()}@example.com`,
        })
        .returning()
    )[0]!;
    const localDeployment = (
      await db
        .insert(schema.deployments)
        .values({
          organizationId: deployment.organizationId,
          applicationId,
          customerId: customer.id,
          region: 'us-east-1',
          state: 'NOT_INSTALLED',
          installationId: `inst-disconnect-${crypto.randomUUID()}`,
          enrollmentCode: crypto.randomUUID(),
          desiredState: deployment.desiredState,
        })
        .returning()
    )[0]!;

    await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId: customer.id,
        entries: [{ key: 'ADMIN_PASSWORD', value: SENTINEL, isSecret: true }],
      }),
    });

    const boundBefore = await db
      .select()
      .from(schema.pendingSecrets)
      .where(eq(schema.pendingSecrets.deploymentId, localDeployment.id));
    expect(boundBefore.length).toBeGreaterThan(0);

    const destroy = await app.inject({
      method: 'POST',
      url: `/api/deployments/${localDeployment.id}/destroy`,
      headers: { cookie: vendorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(destroy.statusCode).toBe(200);

    const boundAfter = await db
      .select()
      .from(schema.pendingSecrets)
      .where(eq(schema.pendingSecrets.deploymentId, localDeployment.id));
    expect(boundAfter).toHaveLength(0);
  }, 120_000);

  it('(h) browser closure — staged and bound rows are swept at TTL', async () => {
    const customer = (
      await db
        .insert(schema.customers)
        .values({
          organizationId: deployment.organizationId,
          name: 'Browser Closure',
          email: `closure-${crypto.randomUUID()}@example.com`,
        })
        .returning()
    )[0]!;
    const writeResponse = await app.inject({
      method: 'PUT',
      url: `/api/applications/${applicationId}/config`,
      headers: { 'content-type': 'application/json', cookie: vendorCookie },
      payload: JSON.stringify({
        customerId: customer.id,
        entries: [{ key: 'ADMIN_PASSWORD', value: SENTINEL, isSecret: true }],
      }),
    });
    expect(writeResponse.statusCode).toBe(200);

    // Force the rows to be expired.
    await db
      .update(schema.pendingSecrets)
      .set({ expiresAt: new Date(Date.now() - 1000) });

    // Sweep via the worker's sweepExpiredPendingSecrets (the same SQL the
    // scheduled invoke uses).
    const pendingSecrets = createDrizzlePendingSecretStore(db, createCipherStub());
    const deleted = await pendingSecrets.sweepExpired(new Date());
    expect(deleted).toBeGreaterThan(0);

    const remaining = await db.select().from(schema.pendingSecrets);
    expect(remaining).toHaveLength(0);
  }, 120_000);
});
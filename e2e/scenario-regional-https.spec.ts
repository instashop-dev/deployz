/**
 * Regional HTTPS certificates — simulated E2E (docs/https-regional-certificates.md,
 * scenarios A-D of the design doc's Phase 14 verification plan, relettered
 * RA-RF here to avoid colliding with the legacy default-HTTPS suite's A-I).
 *
 * Runs the REAL API against the real relay harness (./simulation/relay-harness.ts)
 * exactly like e2e/scenario-default-https.spec.ts, plus a shared, in-process
 * `SimulatedAcmRegistry` (./simulation/simulated-acm-registry.ts) standing in
 * for ACM — the harness's ENSURE_CERTIFICATE/ATTACH_CERTIFICATE executors and
 * a verified INSTALL's inline certificate attach all read/write it. The
 * fixture default-HTTPS DNS provider (server.ts `/internal/fixture/
 * default-dns-*`, gated the same way) already writes the scoped deployment
 * CNAME and the scope validation CNAME — no server-side changes were needed
 * for that half.
 *
 * The registry lives in the SAME Node process as this spec (the harness runs
 * the real relay code in-process with Playwright — see docs/testing/
 * discovery/phase1-design-decisions.md D1), so scenarios read it directly
 * rather than through an HTTP round trip.
 *
 * Every test here skips unless `DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true` (CI runs
 * this file separately with the flag on, alongside the legacy suite — see
 * ci.yml's "Default-HTTPS simulated scenarios" step). The legacy suite
 * (e2e/scenario-default-https.spec.ts) is unaffected: `customerScope` is an
 * additive, opt-in harness option that defaults to absent.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { regionalCertificateDomain, scopedDeploymentHostname } from '@deployz/contracts';

import { API_URL } from './simulation/fixtures.js';
import { extractQuickCreateParam, startSimulatedRelay, type SimulatedRelayHandle } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { SimulatedAcmRegistry } from './simulation/simulated-acm-registry.js';

const APEX = 'deployz-fixture.test';
const AWS_ACCOUNT_ID = '123456789012';
const REGION_A = 'us-east-1';
const REGION_B = 'us-west-2';

interface DnsRecord {
  name: string;
  content: string;
  proxied: boolean;
}

interface DnsSnapshot {
  records: DnsRecord[];
  remainingFailures: number;
  mutations: Array<{ op: string; name: string }>;
}

interface HttpsProgress {
  state: string;
  mode: string;
  substeps: Array<{ key: string; state: string }>;
  slow: boolean;
}

interface DeploymentResponse {
  id: string;
  state: string;
  cleanupState: string | null;
  appUrl?: string | null;
  defaultUrl?: string | null;
  deploymentStatus?: {
    stage: string;
    httpsProgress?: HttpsProgress;
  };
}

async function getDeployment(request: APIRequestContext, id: string): Promise<DeploymentResponse> {
  const response = await request.get(`${API_URL}/api/deployments/${id}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as DeploymentResponse;
}

async function dnsSnapshot(request: APIRequestContext): Promise<DnsSnapshot> {
  const response = await request.get(`${API_URL}/internal/fixture/default-dns-records`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as DnsSnapshot;
}

function recordNamed(snapshot: DnsSnapshot, name: string): DnsRecord | undefined {
  return snapshot.records.find((record) => record.name.toLowerCase() === name.toLowerCase());
}

/** The scope validation CNAME's expected name — one label (`_e2e`) directly
 *  under the customer namespace, mirroring SimulatedAcmRegistry's own
 *  construction and `isScopeValidationRecordName`'s shape requirement. */
function validationRecordNameFor(dnsScope: string): string {
  const domain = regionalCertificateDomain(dnsScope, APEX); // '*.c-<scope>.<apex>'
  return `_e2e.${domain.slice(2)}`; // strip the leading '*.'
}

async function waitForStage(
  request: APIRequestContext,
  deploymentId: string,
  stage: string,
  timeout = 40_000,
): Promise<void> {
  await expect
    .poll(async () => (await getDeployment(request, deploymentId)).deploymentStatus?.stage ?? null, {
      timeout,
      message: `waiting for deployment ${deploymentId} to reach stage ${stage}`,
    })
    .toBe(stage);
}

async function waitForState(
  request: APIRequestContext,
  deploymentId: string,
  state: string,
  timeout = 40_000,
): Promise<void> {
  await expect
    .poll(async () => (await getDeployment(request, deploymentId)).state, {
      timeout,
      message: `waiting for deployment ${deploymentId} to reach state ${state}`,
    })
    .toBe(state);
}

async function waitForCleanupComplete(
  request: APIRequestContext,
  deploymentId: string,
  timeout = 40_000,
): Promise<void> {
  await expect
    .poll(async () => (await getDeployment(request, deploymentId)).cleanupState, {
      timeout,
      message: `waiting for deployment ${deploymentId} cleanup to complete`,
    })
    .toBe('COMPLETE');
}

// ── Seeding helpers (mirrors e2e/simulation/fixtures.ts's own seeding, kept
// local here since every scenario needs several deployments sharing ONE
// customer/registry, which the shared `deployzInstall` fixture does not
// support) ──────────────────────────────────────────────────────────────────

async function signUp(request: APIRequestContext, suffix: string): Promise<void> {
  const email = `e2e-regional-https-${suffix}@example.com`;
  const response = await request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { name: `E2E Regional HTTPS Vendor ${suffix}`, email, password: 'super-secret-1' },
  });
  if (!response.ok()) {
    throw new Error(`sign-up failed: ${response.status()} ${await response.text()}`);
  }
}

async function createCustomer(request: APIRequestContext, suffix: string): Promise<{ id: string; dnsScope: string }> {
  const response = await request.post(`${API_URL}/api/customers`, {
    data: { name: `Regional Customer ${suffix}`, email: `regional-customer-${suffix}@example.com` },
  });
  if (!response.ok()) {
    throw new Error(`create customer failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { id: string; dnsScope: string };
  return { id: body.id, dnsScope: body.dnsScope };
}

async function createApplication(request: APIRequestContext, suffix: string): Promise<string> {
  const appResponse = await request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Regional App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/regional-https-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/regional-https-${suffix}`,
      defaultBranch: 'main',
      databaseRequired: true,
    },
  });
  if (!appResponse.ok()) {
    throw new Error(`create application failed: ${appResponse.status()} ${await appResponse.text()}`);
  }
  const application = (await appResponse.json()) as { id: string };
  const patchResponse = await request.patch(`${API_URL}/api/applications/${application.id}`, {
    data: {
      containerPort: 3000,
      healthPath: '/api/health',
      migrationCommand: 'npm run db:migrate',
      appRoot: '.',
      dockerfilePath: 'Dockerfile',
      buildContext: '.',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
    },
  });
  if (!patchResponse.ok()) {
    throw new Error(`patch application failed: ${patchResponse.status()} ${await patchResponse.text()}`);
  }
  return application.id;
}

interface RegionalDeployment {
  readonly deploymentId: string;
  readonly relay: SimulatedRelayHandle;
}

/** Creates one deployment for `customerId` in `region`, launches it, and
 *  registers a simulated relay carrying `customerScope`/`awsAccountId` so
 *  the control plane selects the regional flow (docs/https-regional-
 *  certificates.md decision 7) — the relay's ENSURE_CERTIFICATE/
 *  ATTACH_CERTIFICATE commands (and a verified INSTALL's inline attach) all
 *  read/write the given `acmRegistry`. */
async function deployAndRegister(
  request: APIRequestContext,
  options: {
    applicationId: string;
    customerId: string;
    dnsScope: string;
    region: string;
    acmRegistry: SimulatedAcmRegistry;
    suffix: string;
  },
): Promise<RegionalDeployment> {
  const deploymentResponse = await request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: options.applicationId, customerId: options.customerId, region: options.region },
  });
  if (!deploymentResponse.ok()) {
    throw new Error(`create deployment failed: ${deploymentResponse.status()} ${await deploymentResponse.text()}`);
  }
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };

  const launchResponse = await request.post(`${API_URL}/api/install/${deployment.installLinkId}/launched`, {
    data: {},
  });
  if (!launchResponse.ok()) {
    throw new Error(`launch failed: ${launchResponse.status()} ${await launchResponse.text()}`);
  }

  const installResponse = await request.get(`${API_URL}/api/install/${deployment.installLinkId}`);
  if (!installResponse.ok()) {
    throw new Error(`get install info failed: ${installResponse.status()}`);
  }
  const installBody = (await installResponse.json()) as { quickCreateUrl: string | null };
  if (!installBody.quickCreateUrl) {
    throw new Error(`No quickCreateUrl for install ${deployment.installLinkId}`);
  }
  const relayCredential = extractQuickCreateParam(installBody.quickCreateUrl, 'RelayCredential');

  const installationId = `inst-regional-${options.suffix}`;
  const relay = startSimulatedRelay({
    scenario: getScenario('happy-path'),
    apiUrl: API_URL,
    installationId,
    enrollmentCode: deployment.enrollmentCode,
    relayToken: relayCredential,
    customerScope: options.dnsScope,
    awsAccountId: AWS_ACCOUNT_ID,
    region: options.region,
    acmRegistry: options.acmRegistry,
  });

  return { deploymentId: deployment.id, relay };
}

const defaultHttpsEnabled = process.env.DEPLOYZ_DEFAULT_HTTPS_FIXTURE === 'true';

test.describe('regional-https', () => {
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the regional-HTTPS suite');

  // ── RA — first deployment ──────────────────────────────────────────────
  test('@scenario:regional-https-ra first deployment requests exactly one certificate and reaches READY on the scoped hostname', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const customer = await createCustomer(request, suffix);
    const applicationId = await createApplication(request, suffix);
    const registry = new SimulatedAcmRegistry();
    const domain = regionalCertificateDomain(customer.dnsScope, APEX);

    const { deploymentId, relay } = await deployAndRegister(request, {
      applicationId,
      customerId: customer.id,
      dnsScope: customer.dnsScope,
      region: REGION_A,
      acmRegistry: registry,
      suffix,
    });

    try {
      await waitForStage(request, deploymentId, 'READY');

      // Exactly one ENSURE request minted a certificate for this domain.
      const requested = registry
        .mutationLog()
        .filter((m) => m.op === 'ENSURE_CERTIFICATE' && m.outcome === 'requested');
      expect(requested).toHaveLength(1);
      expect(registry.certificatesFor(REGION_A, domain)).toHaveLength(1);

      const routingHostname = scopedDeploymentHostname(deploymentId, customer.dnsScope, { zone: APEX });
      const validationName = validationRecordNameFor(customer.dnsScope);

      const snapshot = await dnsSnapshot(request);
      const validationRecord = recordNamed(snapshot, validationName);
      expect(validationRecord).toBeDefined();
      expect(validationRecord!.proxied).toBe(false);

      const routingRecord = recordNamed(snapshot, routingHostname);
      expect(routingRecord).toBeDefined();
      expect(routingRecord!.proxied).toBe(false);

      const deployment = await getDeployment(request, deploymentId);
      expect(deployment.appUrl).toBe(`https://${routingHostname}`);
      expect(deployment.deploymentStatus?.httpsProgress).toBeDefined();
      for (const substep of deployment.deploymentStatus!.httpsProgress!.substeps) {
        expect(substep.state).toBe('done');
      }
    } finally {
      relay.stop();
    }
  });

  // ── RB — second deployment, same customer + region ─────────────────────
  test('@scenario:regional-https-rb second deployment in the same scope reuses the certificate with no new ENSURE request', async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const customer = await createCustomer(request, suffix);
    const applicationId = await createApplication(request, suffix);
    const registry = new SimulatedAcmRegistry();
    const domain = regionalCertificateDomain(customer.dnsScope, APEX);

    const first = await deployAndRegister(request, {
      applicationId,
      customerId: customer.id,
      dnsScope: customer.dnsScope,
      region: REGION_A,
      acmRegistry: registry,
      suffix: `${suffix}-1`,
    });

    try {
      await waitForStage(request, first.deploymentId, 'READY');
      expect(registry.certificatesFor(REGION_A, domain)).toHaveLength(1);
      const certificateArnAfterFirst = registry.certificatesFor(REGION_A, domain)[0]!.arn;
      const mutationCountAfterFirst = registry.mutationLog().length;

      const second = await deployAndRegister(request, {
        applicationId,
        customerId: customer.id,
        dnsScope: customer.dnsScope,
        region: REGION_A,
        acmRegistry: registry,
        suffix: `${suffix}-2`,
      });

      try {
        await waitForStage(request, second.deploymentId, 'READY');

        // No new certificate: still exactly one for this domain+region, same ARN.
        const certsAfterSecond = registry.certificatesFor(REGION_A, domain);
        expect(certsAfterSecond).toHaveLength(1);
        expect(certsAfterSecond[0]!.arn).toBe(certificateArnAfterFirst);

        // No new ENSURE_CERTIFICATE request/issue mutation happened for the
        // second deployment — every mutation logged after the first
        // deployment settled is an ATTACH, never another ENSURE.
        const mutationsAfterSecond = registry.mutationLog().slice(mutationCountAfterFirst);
        expect(mutationsAfterSecond.some((m) => m.op === 'ENSURE_CERTIFICATE')).toBe(false);
        expect(mutationsAfterSecond.some((m) => m.op === 'ATTACH_CERTIFICATE')).toBe(true);

        const secondRoutingHostname = scopedDeploymentHostname(second.deploymentId, customer.dnsScope, {
          zone: APEX,
        });
        const secondDeployment = await getDeployment(request, second.deploymentId);
        expect(secondDeployment.appUrl).toBe(`https://${secondRoutingHostname}`);
      } finally {
        second.relay.stop();
      }
    } finally {
      first.relay.stop();
    }
  });

  // ── RC — new region ─────────────────────────────────────────────────────
  test('@scenario:regional-https-rc a deployment in a new region gets its own certificate in the same customer namespace', async ({
    request,
  }) => {
    test.setTimeout(90_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const customer = await createCustomer(request, suffix);
    const applicationId = await createApplication(request, suffix);
    const registry = new SimulatedAcmRegistry();
    const domain = regionalCertificateDomain(customer.dnsScope, APEX);

    const first = await deployAndRegister(request, {
      applicationId,
      customerId: customer.id,
      dnsScope: customer.dnsScope,
      region: REGION_A,
      acmRegistry: registry,
      suffix: `${suffix}-1`,
    });

    try {
      await waitForStage(request, first.deploymentId, 'READY');
      const firstArn = registry.certificatesFor(REGION_A, domain)[0]!.arn;

      const second = await deployAndRegister(request, {
        applicationId,
        customerId: customer.id,
        dnsScope: customer.dnsScope,
        region: REGION_B,
        acmRegistry: registry,
        suffix: `${suffix}-2`,
      });

      try {
        await waitForStage(request, second.deploymentId, 'READY');

        const regionBCerts = registry.certificatesFor(REGION_B, domain);
        expect(regionBCerts).toHaveLength(1);
        const secondArn = regionBCerts[0]!.arn;
        expect(secondArn).not.toBe(firstArn);
        // Same customer namespace (identical domain string), independent
        // per-region certificate (decision 3: one row per customer+account+region).
        expect(regionBCerts[0]!.domain.toLowerCase()).toBe(domain.toLowerCase());
        expect(regionBCerts[0]!.customerScope).toBe(customer.dnsScope);
        expect(registry.certificatesFor(REGION_A, domain)).toHaveLength(1);
        expect(registry.certificates()).toHaveLength(2);
      } finally {
        second.relay.stop();
      }
    } finally {
      first.relay.stop();
    }
  });

  // ── RD — destroy retains, purge (last deployment) removes ──────────────
  test('@scenario:regional-https-rd destroy removes only the scoped record; purge removes the shared certificate only once no deployment remains', async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const customer = await createCustomer(request, suffix);
    const applicationId = await createApplication(request, suffix);
    const registry = new SimulatedAcmRegistry();
    const domain = regionalCertificateDomain(customer.dnsScope, APEX);

    const first = await deployAndRegister(request, {
      applicationId,
      customerId: customer.id,
      dnsScope: customer.dnsScope,
      region: REGION_A,
      acmRegistry: registry,
      suffix: `${suffix}-1`,
    });
    const second = await deployAndRegister(request, {
      applicationId,
      customerId: customer.id,
      dnsScope: customer.dnsScope,
      region: REGION_A,
      acmRegistry: registry,
      suffix: `${suffix}-2`,
    });

    try {
      await waitForStage(request, first.deploymentId, 'READY');
      await waitForStage(request, second.deploymentId, 'READY');
      expect(registry.certificatesFor(REGION_A, domain)).toHaveLength(1);
      const certificateArn = registry.certificatesFor(REGION_A, domain)[0]!.arn;

      const firstRoutingHostname = scopedDeploymentHostname(first.deploymentId, customer.dnsScope, { zone: APEX });
      const validationName = validationRecordNameFor(customer.dnsScope);

      // DESTROY the first deployment: its own scoped routing record goes
      // away; the shared validation record and certificate survive (the
      // sibling deployment is still live).
      const destroyFirst = await request.post(`${API_URL}/api/deployments/${first.deploymentId}/destroy`, {
        data: {},
      });
      expect(destroyFirst.status()).toBe(202);
      await waitForState(request, first.deploymentId, 'DELETED');

      await expect
        .poll(async () => recordNamed(await dnsSnapshot(request), firstRoutingHostname), {
          timeout: 10_000,
          message: 'DEBUG waiting for scoped routing record removal after destroy',
        })
        .toBeUndefined();
      const afterDestroy = await dnsSnapshot(request);
      expect(recordNamed(afterDestroy, validationName)).toBeDefined();
      expect(registry.certificatesFor(REGION_A, domain)).toHaveLength(1);
      expect(registry.certificatesFor(REGION_A, domain)[0]!.arn).toBe(certificateArn);

      // PURGE the first deployment while its sibling is still alive: the
      // shared certificate is untouched (never carried in this purge).
      const purgeFirst = await request.post(`${API_URL}/api/deployments/${first.deploymentId}/purge`, { data: {} });
      expect(purgeFirst.status()).toBe(202);
      await waitForCleanupComplete(request, first.deploymentId);
      expect(registry.certificatesFor(REGION_A, domain)).toHaveLength(1);
      expect(registry.mutationLog().some((m) => m.op === 'DELETE_CERTIFICATE')).toBe(false);

      // DESTROY + PURGE the last deployment in the scope: the certificate
      // and its validation record finally go away.
      const destroySecond = await request.post(`${API_URL}/api/deployments/${second.deploymentId}/destroy`, {
        data: {},
      });
      expect(destroySecond.status()).toBe(202);
      await waitForState(request, second.deploymentId, 'DELETED');

      const purgeSecond = await request.post(`${API_URL}/api/deployments/${second.deploymentId}/purge`, {
        data: {},
      });
      expect(purgeSecond.status()).toBe(202);
      await waitForCleanupComplete(request, second.deploymentId);

      expect(registry.certificatesFor(REGION_A, domain)).toHaveLength(0);
      expect(
        registry.mutationLog().some((m) => m.op === 'DELETE_CERTIFICATE' && m.arn === certificateArn),
      ).toBe(true);
      // The validation CNAME's removal (completeRegionalCertificateRemoval)
      // is a DNS write following the purge result, same "settles shortly
      // after cleanupState" shape as every other record-removal assertion in
      // this suite (e.g. e2e/scenario-default-https.spec.ts's destroy/purge
      // scenarios) — poll rather than snapshot once.
      await expect
        .poll(async () => recordNamed(await dnsSnapshot(request), validationName), {
          timeout: 10_000,
          message: 'waiting for the scope validation record to be removed after the final purge',
        })
        .toBeUndefined();
    } finally {
      first.relay.stop();
      second.relay.stop();
    }
  });

  // ── RE — recovery: certificate deleted out of band before ISSUED ───────
  test('@scenario:regional-https-re a certificate deleted before issuance is requested again and the deployment still reaches READY', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const customer = await createCustomer(request, suffix);
    const applicationId = await createApplication(request, suffix);
    const registry = new SimulatedAcmRegistry();
    const domain = regionalCertificateDomain(customer.dnsScope, APEX);

    // Deletes the very first certificate this registry ever mints,
    // synchronously within the same `ensure()` call that requested it — no
    // race with the relay's own poll cycle (see SimulatedAcmRegistry's doc
    // comment on `forgetNextRequested`).
    registry.forgetNextRequested();

    const { deploymentId, relay } = await deployAndRegister(request, {
      applicationId,
      customerId: customer.id,
      dnsScope: customer.dnsScope,
      region: REGION_A,
      acmRegistry: registry,
      suffix,
    });

    try {
      await waitForStage(request, deploymentId, 'READY');

      const requested = registry
        .mutationLog()
        .filter(
          (m) =>
            m.op === 'ENSURE_CERTIFICATE' &&
            m.outcome === 'requested' &&
            m.region === REGION_A &&
            m.domain.toLowerCase() === domain.toLowerCase(),
        );
      // The forgotten first request, plus the real replacement.
      expect(requested.length).toBeGreaterThanOrEqual(2);
      // Exactly one certificate survives.
      expect(registry.certificatesFor(REGION_A, domain)).toHaveLength(1);
    } finally {
      relay.stop();
    }
  });

  // ── RF — failure UX ──────────────────────────────────────────────────────
  test('@scenario:regional-https-rf a failed certificate surfaces httpsProgress FAILED without failing the deployment, and retry recovers it', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);
    const customer = await createCustomer(request, suffix);
    const applicationId = await createApplication(request, suffix);
    const registry = new SimulatedAcmRegistry();
    const domain = regionalCertificateDomain(customer.dnsScope, APEX);

    registry.scriptFailure(REGION_A, domain, 'CAA_ERROR');

    const { deploymentId, relay } = await deployAndRegister(request, {
      applicationId,
      customerId: customer.id,
      dnsScope: customer.dnsScope,
      region: REGION_A,
      acmRegistry: registry,
      suffix,
    });

    try {
      // ENSURE_CERTIFICATE runs in parallel with INSTALL (docs/https-regional-
      // certificates.md's whole point), so the scripted certificate failure
      // can surface before the (independent, always-successful here) stack
      // finishes provisioning. Poll for BOTH conditions to settle together
      // rather than asserting `state` the instant httpsProgress reports
      // FAILED — polling httpsProgress alone can observe FAILED while the
      // deployment is still INSTALLING.
      await expect
        .poll(
          async () => {
            const deployment = await getDeployment(request, deploymentId);
            return {
              httpsState: deployment.deploymentStatus?.httpsProgress?.state ?? null,
              state: deployment.state,
            };
          },
          { timeout: 40_000, message: 'waiting for httpsProgress FAILED and the deployment HEALTHY' },
        )
        .toEqual({ httpsState: 'FAILED', state: 'HEALTHY' });

      const failed = await getDeployment(request, deploymentId);
      const progress = failed.deploymentStatus!.httpsProgress!;
      const byKey = Object.fromEntries(progress.substeps.map((s) => [s.key, s.state]));
      expect(byKey['CERTIFICATE_REQUESTED']).toBe('done');
      expect(byKey['DOMAIN_VERIFICATION_CONFIGURED']).toBe('attention');
      expect(byKey['WAITING_FOR_READY']).toBe('attention');
      // The app itself is never failed by an HTTPS setup failure.
      expect(failed.state).toBe('HEALTHY');

      const retry = await request.post(`${API_URL}/api/deployments/${deploymentId}/default-https/retry`, {
        data: {},
      });
      expect(retry.ok()).toBeTruthy();

      await waitForStage(request, deploymentId, 'READY');
      const recovered = await getDeployment(request, deploymentId);
      expect(recovered.deploymentStatus?.httpsProgress?.state).not.toBe('FAILED');
      expect(recovered.state).toBe('HEALTHY');
    } finally {
      relay.stop();
    }
  });
});

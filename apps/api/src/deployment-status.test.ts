import { describe, expect, it } from 'vitest';

import { FAILURE_CODES } from '@deployz/copy-map';

import {
  deriveDeploymentStatus,
  mergeComponentState,
  toCustomerDeploymentStatus,
  toVendorDeploymentStatus,
  type DerivationApplication,
  type DerivationDeployment,
  type DerivationDomain,
  type DerivationJob,
  type DeriveDeploymentStatusInput,
} from './deployment-status.js';

// Unified deployment status — the read-time derivation. Every test here
// builds plain object fixtures and calls the pure functions directly: no
// database, no server, matching the module's own design goal (see the file
// header comment in deployment-status.ts).

const NOW = new Date('2026-08-31T12:00:00.000Z');

function makeDeployment(overrides: Partial<DerivationDeployment> = {}): DerivationDeployment {
  return {
    state: 'NOT_INSTALLED',
    relayStatus: 'UNKNOWN',
    healthStatus: 'UNKNOWN',
    enrollmentUsedAt: null,
    relayBoundAt: null,
    lastHealthAt: null,
    currentReleaseId: null,
    observedState: null,
    updatedAt: NOW,
    installStartedAt: null,
    stepTimings: null,
    ...overrides,
  };
}

function makeApplication(overrides: Partial<DerivationApplication> = {}): DerivationApplication {
  return { databaseRequired: false, storageRequired: false, redisRequired: false, ...overrides };
}

let jobSequence = 0;
function makeJob(overrides: Partial<DerivationJob> = {}): DerivationJob {
  jobSequence += 1;
  return {
    id: `00000000-0000-0000-0000-${jobSequence.toString().padStart(12, '0')}`,
    type: 'INSTALL',
    state: 'SUCCEEDED',
    failureCode: null,
    result: null,
    lastProgressAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makeDomain(overrides: Partial<DerivationDomain> = {}): DerivationDomain {
  return { hostname: 'app.customer.example.com', status: 'ACTIVE', ...overrides };
}

// The relay provisioning snapshot rides observedState.infraHealth.provisioning
// (see packages/relay/src/provision-progress.ts) — this builds the shape
// deployment-status.ts's readProvisioningSnapshot parses.
function snapshotObservedState(
  categories: Record<string, { status: 'IN_PROGRESS' | 'COMPLETE' | 'FAILED'; startedAt?: string; completedAt?: string }>,
  stackStatus?: string,
): Record<string, unknown> {
  return { infraHealth: { provisioning: { categories, ...(stackStatus ? { stackStatus } : {}) } } };
}

function derive(input: Partial<DeriveDeploymentStatusInput> = {}) {
  return deriveDeploymentStatus({
    deployment: makeDeployment(),
    application: makeApplication(),
    jobs: [],
    domain: null,
    appUrl: null,
    ...input,
  });
}

describe('deriveDeploymentStatus — precedence', () => {
  it('nothing has happened yet → WAITING_FOR_AWS', () => {
    const status = derive();
    expect(status.stage).toBe('WAITING_FOR_AWS');
    expect(status.statusUpdatesUnavailable).toBe(false);
  });

  it('enrollmentUsedAt set, no INSTALL job running yet → CONNECTING', () => {
    const status = derive({
      deployment: makeDeployment({ enrollmentUsedAt: NOW }),
      jobs: [makeJob({ state: 'REQUESTED' })],
    });
    expect(status.stage).toBe('CONNECTING');
  });

  it('relayBoundAt set → CONNECTING even with no enrollmentUsedAt', () => {
    const status = derive({ deployment: makeDeployment({ relayBoundAt: NOW }) });
    expect(status.stage).toBe('CONNECTING');
  });

  it('state INSTALLING alone → CONNECTING', () => {
    const status = derive({ deployment: makeDeployment({ state: 'INSTALLING' }) });
    expect(status.stage).toBe('CONNECTING');
  });

  it('latest INSTALL job RUNNING → PROVISIONING, outranking CONNECTING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING', enrollmentUsedAt: NOW }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
  });

  it('latest INSTALL job WAITING also → PROVISIONING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'WAITING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
  });

  it('everInstalled outranks an in-flight INSTALL job (a later attempt cannot regress a healthy deployment)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'RUNNING' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
  });

  it('state FAILED outranks everything else, including everInstalled', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED', currentReleaseId: 'rel-1' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'ECS_DEPLOYMENT_FAILED' })],
    });
    expect(status.stage).toBe('FAILED');
  });
});

describe('deriveDeploymentStatus — the seven spec scenarios', () => {
  it('AWS launched, no relay yet → WAITING_FOR_AWS', () => {
    expect(derive().stage).toBe('WAITING_FOR_AWS');
  });

  it('WAITING_FOR_RELAY (Deploy to AWS pressed, relay not enrolled) is still WAITING_FOR_AWS', () => {
    // The launch signal changes the install page's sub-copy, never the
    // six-stage model — only the relay's first contact moves the stage.
    const status = derive({ deployment: makeDeployment({ state: 'WAITING_FOR_RELAY' }) });
    expect(status.stage).toBe('WAITING_FOR_AWS');
  });

  it('relay registered → CONNECTING', () => {
    const status = derive({ deployment: makeDeployment({ relayBoundAt: NOW }) });
    expect(status.stage).toBe('CONNECTING');
  });

  it('INSTALL running → PROVISIONING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
  });

  it('install done, health pending → VERIFYING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(false);
    expect(status.currentActivity).toBe('Running health checks.');
  });

  it('healthy + https → READY', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
    expect(status.result).toEqual({ url: 'https://app.example.com' });
  });

  it('healthy + http-only → VERIFYING + needsDomainSetup, with the temporary HTTP address exposed', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb-123.us-east-1.elb.amazonaws.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(true);
    expect(status.currentActivity).toBe('Waiting for secure domain setup.');
    // Run-time health confirmed the app is reachable over HTTP — the
    // temporary ALB address is real and must be shown, never "no address".
    expect(status.result).toEqual({ url: 'http://alb-123.us-east-1.elb.amazonaws.com' });
  });

  it('an HTTP appUrl is NOT exposed while health is still unverified', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb-123.us-east-1.elb.amazonaws.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(false);
    expect(status.result).toBeNull();
  });

  it('terminal failure → FAILED', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'PORT_MISMATCH' })],
    });
    expect(status.stage).toBe('FAILED');
    expect(status.failure?.code).toBe('PORT_MISMATCH');
  });

  it('relay outage on an already-healthy deployment → stage retained, statusUpdatesUnavailable', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'DISCONNECTED' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
    expect(status.statusUpdatesUnavailable).toBe(true);
  });
});

describe('relay outage / DISCONNECTED handling', () => {
  it('never regresses stage: a stale relay on a healthy deployment stays VERIFYING/READY, not FAILED or WAITING_FOR_AWS', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'DISCONNECTED' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.statusUpdatesUnavailable).toBe(true);
  });

  it('a disconnected relay that has already registered never yields WAITING_FOR_AWS', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        relayBoundAt: NOW,
        relayStatus: 'DISCONNECTED',
      }),
      jobs: [],
    });
    expect(status.stage).not.toBe('WAITING_FOR_AWS');
    expect(status.stage).toBe('CONNECTING');
    expect(status.statusUpdatesUnavailable).toBe(true);
  });

  it('the never-written DISCONNECTED deployment state is treated defensively as an installed, stale-relay deployment', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'DISCONNECTED',
        healthStatus: 'HEALTHY',
        relayStatus: 'CONNECTED', // even if relayStatus itself disagrees, deployment.state DISCONNECTED still marks the outage
      }),
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
    expect(status.statusUpdatesUnavailable).toBe(true);
  });
});

describe('CloudFormation-complete-but-unverified', () => {
  it('INSTALL SUCCEEDED but healthStatus still UNKNOWN never reaches READY', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN', currentReleaseId: null }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('VERIFYING');
  });

  it('a successful INSTALL that left the persisted state INSTALLING derives VERIFYING the same way (runtime verification is the gate)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING', healthStatus: 'UNKNOWN', currentReleaseId: null }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    // App not confirmed reachable yet — no address is displayed.
    expect(status.result).toBeNull();
  });

  it('the same INSTALLING persisted state with confirmed health exposes the http address but stays VERIFYING (no https)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING', healthStatus: 'HEALTHY', currentReleaseId: null }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(true);
    expect(toCustomerDeploymentStatus(status).url).toBe('http://alb.example.com');
  });

  it('a SUCCESS (legacy) INSTALL job counts as installed the same as SUCCEEDED', () => {
    // deployment.state deliberately NOT in the ever-installed set, so
    // everInstalled can only come from the job itself — isolating the
    // SUCCESS/SUCCEEDED legacy-state equivalence from the state-based rule.
    const status = derive({
      deployment: makeDeployment({ state: 'NOT_INSTALLED', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCESS' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.stage).toBe('READY');
  });
});

describe('removed flag', () => {
  it('DELETING sets removed without hiding the underlying stage', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'DELETING', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.removed).toEqual({ state: 'DELETING' });
    expect(status.stage).toBe('READY');
    expect(toCustomerDeploymentStatus(status).removed).toBe(true);
  });

  it('DELETED sets removed the same way', () => {
    const status = derive({ deployment: makeDeployment({ state: 'DELETED' }) });
    expect(status.removed).toEqual({ state: 'DELETED' });
  });

  it('a live deployment has no removed field at all', () => {
    const status = derive({ deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }) });
    expect(status.removed).toBeUndefined();
    expect(toCustomerDeploymentStatus(status).removed).toBe(false);
  });
});

describe('customer projection sanitization', () => {
  function sensitiveScenario() {
    return derive({
      deployment: makeDeployment({ state: 'FAILED', relayStatus: 'CONNECTED', lastHealthAt: NOW }),
      jobs: [
        makeJob({
          state: 'FAILED',
          failureCode: 'DATABASE_CONNECTION_FAILED',
          result: {
            stackStatus: 'CREATE_FAILED',
            // Deliberately planted secrets that must never reach the wire —
            // this is what a raw job.result blob could realistically carry.
            error: 'connection refused to db.internal at 10.0.4.12:5432',
            awsAccountId: '123456789012',
            enrollmentCode: 'SUPER-SECRET-ENROLLMENT-CODE',
            relayToken: 'tok_live_abcdef0123456789',
          },
        }),
      ],
    });
  }

  it('never leaks account ids, enrollment codes, tokens, or raw error text', () => {
    const customer = toCustomerDeploymentStatus(sensitiveScenario());
    const wire = JSON.stringify(customer);
    expect(wire).not.toContain('123456789012');
    expect(wire).not.toContain('SUPER-SECRET-ENROLLMENT-CODE');
    expect(wire).not.toContain('tok_live_abcdef0123456789');
    expect(wire).not.toContain('10.0.4.12');
    expect(wire).not.toContain('connection refused');
    expect(wire).not.toContain('awsAccountId');
    expect(wire).not.toContain('enrollmentCode');
    expect(wire).not.toContain('token');
  });

  it('carries no relay/job block and no vendorMessage', () => {
    const customer = toCustomerDeploymentStatus(sensitiveScenario());
    expect(customer).not.toHaveProperty('relay');
    expect(customer).not.toHaveProperty('job');
    expect(customer).not.toHaveProperty('aws');
    expect(customer).not.toHaveProperty('health');
    expect(JSON.stringify(customer)).not.toContain('vendorMessage');
  });

  it('the stack status reaches failure.technical only as a jargon-free phrase', () => {
    const customer = toCustomerDeploymentStatus(sensitiveScenario());
    // §65: never the raw CloudFormation enum value on the customer surface —
    // customerStackStatusLabel maps it to plain language.
    expect(customer.failure?.technical?.awsStatus).toBe('Setup did not complete');
    // "stackStatus" as a KEY name never appears — it is carried under
    // technical.awsStatus instead.
    expect(JSON.stringify(customer)).not.toContain('stackStatus');
    expect(JSON.stringify(customer)).not.toContain('CREATE_FAILED');
  });

  it('the vendor projection, by contrast, does carry the full operational detail', () => {
    const vendor = toVendorDeploymentStatus(sensitiveScenario());
    expect(vendor.relay).toBeDefined();
    expect(vendor.job).toBeDefined();
    expect(vendor.aws.stackStatus).toBe('CREATE_FAILED');
    expect(vendor.failure?.message).toBeTruthy();
  });

  it('reads stackStatus and checks from the real relay result nesting (result.output.*)', () => {
    // A live relay reports `{ success, output: { stackStatus, checks, ... } }`
    // (see POST /api/relay/commands/:id/result) — verified against a real
    // us-west-2 install. Top-level fields are the fixture/legacy shape.
    const derived = derive({
      deployment: makeDeployment({ state: 'FAILED', relayStatus: 'CONNECTED', lastHealthAt: NOW }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [
        makeJob({
          state: 'FAILED',
          failureCode: 'DATABASE_CREATE_FAILED',
          result: {
            success: false,
            output: {
              stackStatus: 'ROLLBACK_COMPLETE',
              checks: [{ name: 'database', passed: false }],
            },
          },
        }),
      ],
    });
    const vendor = toVendorDeploymentStatus(derived);
    expect(vendor.aws.stackStatus).toBe('ROLLBACK_COMPLETE');
    expect(derived.components.find((c) => c.key === 'database')?.status).toBe('FAILED');
  });
});

describe('customer/vendor stage invariant', () => {
  const scenarios: DeriveDeploymentStatusInput[] = [
    { deployment: makeDeployment(), application: makeApplication(), jobs: [], domain: null, appUrl: null },
    {
      deployment: makeDeployment({ relayBoundAt: NOW }),
      application: makeApplication(),
      jobs: [],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'INSTALLING' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'RUNNING' })],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: makeDomain(),
      appUrl: 'https://app.example.com',
    },
    {
      deployment: makeDeployment({ state: 'FAILED' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'UNKNOWN' })],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'DELETING', healthStatus: 'HEALTHY' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: null,
      appUrl: 'http://alb.example.com',
    },
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY', relayStatus: 'DISCONNECTED' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: null,
      appUrl: 'https://app.example.com',
    },
  ];

  it.each(scenarios.map((input, index) => [index, input] as const))(
    'scenario %i: customer.stage === vendor.stage',
    (_index, input) => {
      const derived = deriveDeploymentStatus(input);
      expect(toCustomerDeploymentStatus(derived).stage).toBe(toVendorDeploymentStatus(derived).stage);
    },
  );
});

describe('failure mapping', () => {
  it('every §61 failure code has a non-empty customer message', () => {
    for (const code of FAILURE_CODES) {
      const status = derive({
        deployment: makeDeployment({ state: 'FAILED' }),
        jobs: [makeJob({ state: 'FAILED', failureCode: code })],
      });
      const customer = toCustomerDeploymentStatus(status);
      expect(customer.failure?.customerMessage, `code ${code}`).toBeTruthy();
      expect(customer.failure?.customerMessage.length ?? 0, `code ${code}`).toBeGreaterThan(0);
    }
  });

  it('a FAILED job with no classified code falls back to the generic customer message', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: null })],
    });
    const customer = toCustomerDeploymentStatus(status);
    expect(customer.failure?.customerMessage).toBe('Deployment needs attention.');
  });

  it('reference is DEP- plus the failed job id\'s first 8 hex characters, uppercased', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ id: 'abcdef12-0000-0000-0000-000000000000', state: 'FAILED', failureCode: 'UNKNOWN' })],
    });
    expect(status.failure?.reference).toBe('DEP-ABCDEF12');
  });

  it('a failure code maps to a component when one is reliably known', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'REDIS_CONNECTION_FAILED' })],
    });
    expect(status.failure?.component).toBe('redis');
  });

  it('an account/stack-level failure code has no single component', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'AWS_SCP_BLOCKED' })],
    });
    expect(status.failure?.component).toBeNull();
  });
});

describe('mergeComponentState', () => {
  // application/loadBalancer are unconditionally required, so in practice the
  // merge always yields at least those two keys (as UNKNOWN) — null is only
  // reachable if a future caller ever made them optional too. Preserves the
  // exact toFleetRow behavior this was extracted from.
  it('reports application/loadBalancer as UNKNOWN, never null, even with nothing observed', () => {
    expect(mergeComponentState(null, {})).toEqual({ application: 'UNKNOWN', loadBalancer: 'UNKNOWN' });
  });

  it('passes through a reported heartbeat status verbatim', () => {
    const merged = mergeComponentState({ components: { application: 'DEGRADED' } }, {});
    expect(merged?.application).toBe('DEGRADED');
  });

  it('falls back to NOT_PROVISIONED when a required check reports absent', () => {
    const merged = mergeComponentState(
      { infraHealth: { checks: [{ name: 'database', passed: false }] } },
      { databaseRequired: true },
    );
    expect(merged?.database).toBe('NOT_PROVISIONED');
  });

  it('falls back to UNKNOWN when required but never checked either', () => {
    const merged = mergeComponentState({}, { databaseRequired: true });
    expect(merged?.database).toBe('UNKNOWN');
  });

  it('omits an optional component nobody reported or required', () => {
    const merged = mergeComponentState({}, { redisRequired: false });
    expect(merged?.redis).toBeUndefined();
  });
});

describe('component progress list', () => {
  it('an unrequired component is NOT_REQUIRED for the vendor and absent for the customer', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      application: makeApplication({ redisRequired: false }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    const vendor = toVendorDeploymentStatus(status);
    const customer = toCustomerDeploymentStatus(status);
    expect(vendor.components.find((c) => c.key === 'redis')?.status).toBe('NOT_REQUIRED');
    expect(customer.components.find((c) => c.key === 'redis')).toBeUndefined();
  });

  it('an https ERROR is component-level only and does not fail the whole stage', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: makeDomain({ status: 'ERROR' }),
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.components.find((c) => c.key === 'https')?.status).toBe('FAILED');
  });

  it('https is omitted entirely before VERIFYING when there is no domain and no domain setup pending', () => {
    const status = derive({ deployment: makeDeployment({ state: 'INSTALLING' }) });
    expect(status.components.find((c) => c.key === 'https')).toBeUndefined();
  });
});

describe('step derivation — one per stage', () => {
  it('WAITING_FOR_AWS → AWS_SETUP', () => {
    expect(derive().step).toBe('AWS_SETUP');
  });

  it('CONNECTING → RELAY_CONNECT', () => {
    const status = derive({ deployment: makeDeployment({ relayBoundAt: NOW }) });
    expect(status.step).toBe('RELAY_CONNECT');
  });

  it('PROVISIONING with no snapshot yet → PREPARING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
    expect(status.step).toBe('PREPARING');
  });

  it('VERIFYING, health not yet confirmed → HEALTH_CHECK', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.step).toBe('HEALTH_CHECK');
  });

  it('VERIFYING, needsDomainSetup → TLS', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: null,
    });
    expect(status.needsDomainSetup).toBe(true);
    expect(status.step).toBe('TLS');
  });

  it('READY → READY', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.step).toBe('READY');
  });

  it('FAILED on a non-INSTALL job → APPLICATION (it never touched provisioning)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED', currentReleaseId: 'rel-1' }),
      jobs: [makeJob({ type: 'DEPLOY_RELEASE', state: 'FAILED', failureCode: 'IMAGE_PULL_FAILED' })],
    });
    expect(status.step).toBe('APPLICATION');
  });

  it('FAILED DEPLOY_RELEASE with MIGRATION_FAILED names the MIGRATION step', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED', currentReleaseId: 'rel-1' }),
      application: makeApplication({ migrationCommand: 'npm run db:migrate' }),
      jobs: [makeJob({ type: 'DEPLOY_RELEASE', state: 'FAILED', failureCode: 'MIGRATION_FAILED' })],
    });
    expect(status.steps).toContain('MIGRATION');
    expect(status.step).toBe('MIGRATION');
  });

  it('FAILED INSTALL with no snapshot falls back to the FAILURE_COMPONENT map (database)', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ type: 'INSTALL', state: 'FAILED', failureCode: 'DATABASE_CREATE_FAILED' })],
    });
    expect(status.step).toBe('DATABASE_STORAGE');
  });

  it('FAILED fallback never names a step outside the applicable list', () => {
    // A REDIS_* failure code on an application whose redisRequired flag has
    // since been turned off: REDIS is not in `steps`, so highlighting it
    // would leave both progress lists with nothing marked. The broadest
    // truthful in-stage step stands in instead.
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      application: makeApplication({ redisRequired: false }),
      jobs: [makeJob({ type: 'INSTALL', state: 'FAILED', failureCode: 'REDIS_PROVISIONING_FAILED' })],
    });
    expect(status.steps).not.toContain('REDIS');
    expect(status.step).toBe('PREPARING');
  });

  it('FAILED INSTALL with no snapshot and no classified component falls back to PREPARING', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ type: 'INSTALL', state: 'FAILED', failureCode: 'AWS_SCP_BLOCKED' })],
    });
    expect(status.step).toBe('PREPARING');
  });

  it('FAILED INSTALL prefers the snapshot over the FAILURE_COMPONENT map when one is available', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'FAILED',
        observedState: snapshotObservedState({ network: { status: 'FAILED' } }),
      }),
      jobs: [makeJob({ type: 'INSTALL', state: 'FAILED', failureCode: 'DATABASE_CREATE_FAILED' })],
    });
    // The snapshot says NETWORK never completed — more truthful than the
    // failure code's own component guess.
    expect(status.step).toBe('NETWORK');
  });
});

describe('rollback-window snapshots', () => {
  it('does not regress the step from a rolling-back snapshot — broader PREPARING instead', () => {
    // Observed live: mid-rollback the categories describe teardown, and the
    // forward ladder read them as "network not complete → Creating network".
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState(
          { network: { status: 'IN_PROGRESS' }, database: { status: 'IN_PROGRESS' } },
          'ROLLBACK_IN_PROGRESS',
        ),
      }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.stage).toBe('PROVISIONING');
    expect(status.step).toBe('PREPARING');
  });

  it('a FAILED category still names the step where the attempt stopped, even mid-rollback', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState(
          { network: { status: 'IN_PROGRESS' }, application: { status: 'FAILED' } },
          'ROLLBACK_IN_PROGRESS',
        ),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('APPLICATION');
  });

  it('suppresses takingLongerThanUsual while the stack rolls back', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState(
          { application: { status: 'FAILED', startedAt: '2026-08-31T10:00:00.000Z' } },
          'ROLLBACK_IN_PROGRESS',
        ),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: new Date('2026-08-31T11:00:00.000Z'),
    });
    expect(status.takingLongerThanUsual).toBe(false);
  });
});

describe('aws.stackStatus from the live snapshot', () => {
  it('falls back to the snapshot stack status while the INSTALL result is still null', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS' } }, 'CREATE_IN_PROGRESS'),
      }),
      jobs: [makeJob({ state: 'RUNNING', result: null })],
    });
    expect(status.aws.stackStatus).toBe('CREATE_IN_PROGRESS');
  });

  it('a settled stack job result still wins over a stale snapshot status', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS' } }, 'CREATE_IN_PROGRESS'),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED', result: { output: { stackStatus: 'CREATE_COMPLETE' } } })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
    });
    expect(status.aws.stackStatus).toBe('CREATE_COMPLETE');
  });
});

describe('step derivation — snapshot-driven provisioning ladder', () => {
  it('network still in progress → NETWORK', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS' } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('NETWORK');
  });

  it('network complete, required database still in progress → DATABASE_STORAGE', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', startedAt: 't0', completedAt: 't1' },
          database: { status: 'IN_PROGRESS' },
        }),
      }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('DATABASE_STORAGE');
  });

  it('DATABASE_STORAGE only counts as complete once EVERY required sub-category is complete', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', completedAt: 't1' },
          database: { status: 'COMPLETE', completedAt: 't2' },
          storage: { status: 'IN_PROGRESS' },
        }),
      }),
      application: makeApplication({ databaseRequired: true, storageRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('DATABASE_STORAGE');
  });

  it('redis required and incomplete (database/storage not required) → REDIS', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', completedAt: 't1' },
          redis: { status: 'IN_PROGRESS' },
        }),
      }),
      application: makeApplication({ redisRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('REDIS');
  });

  it('an unrequired category never gates the ladder, even if the snapshot never reports it', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', completedAt: 't1' },
          application: { status: 'COMPLETE', completedAt: 't2' },
        }),
      }),
      application: makeApplication({ databaseRequired: false, redisRequired: false }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('APPLICATION');
  });

  it('everything complete → APPLICATION', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({
          network: { status: 'COMPLETE', completedAt: 't1' },
          application: { status: 'IN_PROGRESS' },
        }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    expect(status.step).toBe('APPLICATION');
  });
});

describe('applicable steps list', () => {
  it('REDIS is present only when the application requires it', () => {
    expect(derive({ application: makeApplication({ redisRequired: true }) }).steps).toContain('REDIS');
    expect(derive({ application: makeApplication({ redisRequired: false }) }).steps).not.toContain('REDIS');
  });

  it('DATABASE_STORAGE is present iff database OR storage is required', () => {
    expect(derive({ application: makeApplication() }).steps).not.toContain('DATABASE_STORAGE');
    expect(derive({ application: makeApplication({ databaseRequired: true }) }).steps).toContain('DATABASE_STORAGE');
    expect(derive({ application: makeApplication({ storageRequired: true }) }).steps).toContain('DATABASE_STORAGE');
  });

  it('is always in canonical order', () => {
    const status = derive({
      application: makeApplication({
        databaseRequired: true,
        redisRequired: true,
        migrationCommand: 'npm run db:migrate',
      }),
    });
    expect(status.steps).toEqual([
      'AWS_SETUP',
      'RELAY_CONNECT',
      'PREPARING',
      'NETWORK',
      'DATABASE_STORAGE',
      'REDIS',
      'MIGRATION',
      'APPLICATION',
      'HEALTH_CHECK',
      'TLS',
      'READY',
    ]);
  });

  it('MIGRATION is present only when the application has a migration command', () => {
    expect(derive({ application: makeApplication({ migrationCommand: 'npm run db:migrate' }) }).steps).toContain(
      'MIGRATION',
    );
    expect(derive({ application: makeApplication({ migrationCommand: null }) }).steps).not.toContain('MIGRATION');
    expect(derive({ application: makeApplication() }).steps).not.toContain('MIGRATION');
  });
});

describe('takingLongerThanUsual', () => {
  it('is false while the active step is within its typical range', () => {
    const startedAt = new Date(NOW.getTime() - 100_000); // NETWORK max is 360s
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS', startedAt: startedAt.toISOString() } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: NOW,
    });
    expect(status.step).toBe('NETWORK');
    expect(status.takingLongerThanUsual).toBe(false);
  });

  it('becomes true once elapsed time crosses the step max', () => {
    const startedAt = new Date(NOW.getTime() - 400_000); // past NETWORK's 360s max
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS', startedAt: startedAt.toISOString() } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: NOW,
    });
    expect(status.takingLongerThanUsual).toBe(true);
  });

  it('never changes the stage — a slow step is not a failure', () => {
    const startedAt = new Date(NOW.getTime() - 999_999_000);
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS', startedAt: startedAt.toISOString() } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: NOW,
    });
    expect(status.takingLongerThanUsual).toBe(true);
    expect(status.stage).toBe('PROVISIONING');
  });

  it('is suppressed when statusUpdatesUnavailable — a silent relay cannot support the claim', () => {
    const startedAt = new Date(NOW.getTime() - 400_000);
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        relayStatus: 'DISCONNECTED',
        observedState: snapshotObservedState({ network: { status: 'IN_PROGRESS', startedAt: startedAt.toISOString() } }),
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
      now: NOW,
    });
    expect(status.statusUpdatesUnavailable).toBe(true);
    expect(status.takingLongerThanUsual).toBe(false);
  });

  it('is false at READY (no typical range) even with a very old timestamp', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'https://app.example.com',
      domain: makeDomain(),
      now: new Date(NOW.getTime() + 999_999_000),
    });
    expect(status.takingLongerThanUsual).toBe(false);
  });

  it('is false at FAILED, even when the active step started long before now', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'FAILED' }),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'UNKNOWN' })],
      now: new Date(NOW.getTime() + 999_999_000),
    });
    expect(status.stage).toBe('FAILED');
    expect(status.takingLongerThanUsual).toBe(false);
  });
});

describe('stepStartedAt resolution ladder', () => {
  it('AWS_SETUP falls back to deployment.installStartedAt', () => {
    const installStartedAt = new Date('2026-08-31T10:00:00.000Z');
    const status = derive({ deployment: makeDeployment({ installStartedAt }) });
    expect(status.step).toBe('AWS_SETUP');
    expect(status.stepStartedAt).toBe(installStartedAt.toISOString());
  });

  it('RELAY_CONNECT prefers enrollmentUsedAt over relayBoundAt', () => {
    const enrollmentUsedAt = new Date('2026-08-31T10:05:00.000Z');
    const relayBoundAt = new Date('2026-08-31T10:01:00.000Z');
    const status = derive({ deployment: makeDeployment({ enrollmentUsedAt, relayBoundAt }) });
    expect(status.step).toBe('RELAY_CONNECT');
    expect(status.stepStartedAt).toBe(enrollmentUsedAt.toISOString());
  });

  it('RELAY_CONNECT falls back to relayBoundAt when enrollmentUsedAt is unset', () => {
    const relayBoundAt = new Date('2026-08-31T10:01:00.000Z');
    const status = derive({ deployment: makeDeployment({ relayBoundAt }) });
    expect(status.stepStartedAt).toBe(relayBoundAt.toISOString());
  });

  it('PREPARING falls back to the latest INSTALL job startedAt, else createdAt', () => {
    const createdAt = new Date('2026-08-31T10:10:00.000Z');
    const startedAt = new Date('2026-08-31T10:12:00.000Z');
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'RUNNING', createdAt, startedAt })],
    });
    expect(status.step).toBe('PREPARING');
    expect(status.stepStartedAt).toBe(startedAt.toISOString());
  });

  it('PREPARING falls back to createdAt when the INSTALL job has no startedAt', () => {
    const createdAt = new Date('2026-08-31T10:10:00.000Z');
    const status = derive({
      deployment: makeDeployment({ state: 'INSTALLING' }),
      jobs: [makeJob({ state: 'RUNNING', createdAt, startedAt: null })],
    });
    expect(status.stepStartedAt).toBe(createdAt.toISOString());
  });

  it('HEALTH_CHECK falls back to the latest INSTALL job finishedAt', () => {
    const finishedAt = new Date('2026-08-31T10:20:00.000Z');
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'UNKNOWN' }),
      jobs: [makeJob({ state: 'SUCCEEDED', finishedAt })],
    });
    expect(status.step).toBe('HEALTH_CHECK');
    expect(status.stepStartedAt).toBe(finishedAt.toISOString());
  });

  it('TLS has no authoritative fallback and stays null', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb.example.com',
      domain: null,
    });
    expect(status.step).toBe('TLS');
    expect(status.stepStartedAt).toBeNull();
  });

  it('a persisted step_timings entry always wins over the authoritative fallback', () => {
    const persisted = new Date('2026-08-31T09:00:00.000Z');
    const installStartedAt = new Date('2026-08-31T10:00:00.000Z');
    const status = derive({
      deployment: makeDeployment({
        installStartedAt,
        stepTimings: { AWS_SETUP: { startedAt: persisted.toISOString() } },
      }),
    });
    expect(status.stepStartedAt).toBe(persisted.toISOString());
  });
});

describe('customer/vendor step invariant', () => {
  const scenarios: DeriveDeploymentStatusInput[] = [
    { deployment: makeDeployment(), application: makeApplication(), jobs: [], domain: null, appUrl: null },
    {
      deployment: makeDeployment({ relayBoundAt: NOW }),
      application: makeApplication(),
      jobs: [],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'INSTALLING' }),
      application: makeApplication({ databaseRequired: true }),
      jobs: [makeJob({ state: 'RUNNING' })],
      domain: null,
      appUrl: null,
    },
    {
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      domain: makeDomain(),
      appUrl: 'https://app.example.com',
    },
    {
      deployment: makeDeployment({ state: 'FAILED' }),
      application: makeApplication(),
      jobs: [makeJob({ state: 'FAILED', failureCode: 'REDIS_CONNECTION_FAILED' })],
      domain: null,
      appUrl: null,
    },
  ];

  it.each(scenarios.map((input, index) => [index, input] as const))(
    'scenario %i: customer.step === vendor.step === derived.step',
    (_index, input) => {
      const derived = deriveDeploymentStatus(input);
      const customer = toCustomerDeploymentStatus(derived);
      const vendor = toVendorDeploymentStatus(derived);
      expect(customer.step).toBe(derived.step);
      expect(vendor.step).toBe(derived.step);
      expect(customer.step).toBe(vendor.step);
      expect(customer.steps).toEqual(vendor.steps);
    },
  );
});

describe('customer projection never carries stepStartedAt/stepTimings', () => {
  it('the wire object has neither key, even though the derivation computed both', () => {
    const status = derive({
      deployment: makeDeployment({
        installStartedAt: NOW,
        stepTimings: { AWS_SETUP: { startedAt: NOW.toISOString() } },
      }),
    });
    const customer = toCustomerDeploymentStatus(status);
    expect(customer).not.toHaveProperty('stepStartedAt');
    expect(customer).not.toHaveProperty('stepTimings');
  });
});

describe('vendor stepTimings projection', () => {
  it('carries the persisted map as an ordered array with computed durations', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'INSTALLING',
        stepTimings: {
          AWS_SETUP: { startedAt: '2026-08-31T10:00:00.000Z', completedAt: '2026-08-31T10:02:00.000Z' },
          RELAY_CONNECT: { startedAt: '2026-08-31T10:02:00.000Z' },
        },
      }),
      jobs: [makeJob({ state: 'RUNNING' })],
    });
    const vendor = toVendorDeploymentStatus(status);
    expect(vendor.stepTimings).toEqual([
      { step: 'AWS_SETUP', startedAt: '2026-08-31T10:00:00.000Z', completedAt: '2026-08-31T10:02:00.000Z', durationSeconds: 120 },
      { step: 'RELAY_CONNECT', startedAt: '2026-08-31T10:02:00.000Z', completedAt: null, durationSeconds: null },
    ]);
  });
});

// §10.1 layered runtime health — each layer reports what ITS source observed,
// never collapsed into the scalar health status.
describe('layered runtime health (health.layers)', () => {
  function observed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      infraHealth: { verified: true, checks: [] },
      deploymentRolloutState: 'COMPLETED',
      desiredCount: 2,
      runningCount: 2,
      unhealthyTargetCount: 0,
      pendingTargetCount: 0,
      unknownTargetCount: 0,
      httpProbe: {
        ok: true,
        statusCode: 200,
        latencyMs: 41,
        checkedAt: '2026-09-02T00:00:00.000Z',
        lastSuccessAt: '2026-09-02T00:00:00.000Z',
        lastFailedAt: null,
      },
      ...overrides,
    };
  }

  it('exposes every layer separately when every source reported', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        relayStatus: 'CONNECTED',
        observedState: observed(),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.health.layers).toEqual({
      infrastructure: 'HEALTHY',
      rollout: 'COMPLETED',
      targets: {
        desiredCount: 2,
        runningCount: 2,
        unhealthyTargetCount: 0,
        pendingTargetCount: 0,
        unknownTargetCount: 0,
      },
      http: {
        ok: true,
        statusCode: 200,
        latencyMs: 41,
        checkedAt: '2026-09-02T00:00:00.000Z',
        lastSuccessAt: '2026-09-02T00:00:00.000Z',
        lastFailedAt: null,
      },
      relay: 'CONNECTED',
    });
    // And the vendor projection carries them verbatim.
    expect(toVendorDeploymentStatus(status).health.layers).toEqual(status.health.layers);
  });

  it('a failing HTTP probe stays a separate layer from healthy ECS/ALB layers', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        relayStatus: 'CONNECTED',
        observedState: observed({
          httpProbe: {
            ok: false,
            statusCode: 503,
            latencyMs: 12,
            checkedAt: '2026-09-02T00:00:01.000Z',
            lastSuccessAt: null,
            lastFailedAt: '2026-09-02T00:00:01.000Z',
          },
        }),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    // ECS still reports every target healthy and the rollout completed — the
    // app-level failure is visible only in the http layer, not smeared over
    // the others.
    expect(status.health.layers.rollout).toBe('COMPLETED');
    expect(status.health.layers.targets).toMatchObject({ unhealthyTargetCount: 0 });
    expect(status.health.layers.http).toMatchObject({ ok: false, statusCode: 503 });
    expect(status.health.status).toBe('HEALTHY');
  });

  it('an in-progress rollout is visible even while counts and probe look fine', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'DEGRADED',
        observedState: observed({ deploymentRolloutState: 'IN_PROGRESS' }),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.health.layers.rollout).toBe('IN_PROGRESS');
  });

  it('absent observations are honest UNKNOWNs, never healthy-looking zeros', () => {
    const status = derive({
      deployment: makeDeployment({ relayStatus: 'UNKNOWN' }),
    });
    expect(status.health.layers).toEqual({
      infrastructure: 'UNKNOWN',
      rollout: null,
      targets: null,
      http: null,
      relay: 'UNKNOWN',
    });
  });

  it('verification failure surfaces as an unhealthy infrastructure layer', () => {
    const status = derive({
      deployment: makeDeployment({
        state: 'HEALTHY',
        healthStatus: 'HEALTHY',
        observedState: observed({ infraHealth: { verified: false, checks: [] } }),
      }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
    });
    expect(status.health.layers.infrastructure).toBe('UNHEALTHY');
  });
});

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
    finishedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makeDomain(overrides: Partial<DerivationDomain> = {}): DerivationDomain {
  return { hostname: 'app.customer.example.com', status: 'ACTIVE', ...overrides };
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

  it('healthy + http-only → VERIFYING + needsDomainSetup', () => {
    const status = derive({
      deployment: makeDeployment({ state: 'HEALTHY', healthStatus: 'HEALTHY' }),
      jobs: [makeJob({ state: 'SUCCEEDED' })],
      appUrl: 'http://alb-123.us-east-1.elb.amazonaws.com',
      domain: null,
    });
    expect(status.stage).toBe('VERIFYING');
    expect(status.needsDomainSetup).toBe(true);
    expect(status.currentActivity).toBe('Waiting for secure domain setup.');
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

  it('the one allowed AWS status word lives only inside failure.technical', () => {
    const customer = toCustomerDeploymentStatus(sensitiveScenario());
    expect(customer.failure?.technical?.awsStatus).toBe('CREATE_FAILED');
    // "stackStatus" as a KEY name never appears — it is carried under
    // technical.awsStatus instead.
    expect(JSON.stringify(customer)).not.toContain('stackStatus');
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

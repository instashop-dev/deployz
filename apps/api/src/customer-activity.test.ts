import { describe, expect, it } from 'vitest';

import type { RuntimeHealthLayers } from '@deployz/contracts';

import {
  buildCustomerLiveProgress,
  findProvisioningIssue,
  translateStackEvents,
  type BuildCustomerLiveProgressInput,
  type StackEventLike,
} from './customer-activity.js';

// Pure module — every test builds plain object fixtures and calls the
// exported functions directly: no DB, no server, no clock (every timestamp
// is an explicit fixture value), matching the module's own design goal.

const T0 = new Date('2026-09-18T10:00:00.000Z').getTime();
const at = (offsetSeconds: number): Date => new Date(T0 + offsetSeconds * 1000);

function event(overrides: Partial<StackEventLike> & Pick<StackEventLike, 'logicalResourceId' | 'resourceType' | 'resourceStatus'>): StackEventLike {
  return {
    eventAt: at(0),
    resourceStatusReason: null,
    ...overrides,
  };
}

const NO_HEALTH: RuntimeHealthLayers = {
  infrastructure: null,
  rollout: null,
  targets: null,
  http: null,
  relay: 'UNKNOWN',
};

function baseLiveInput(overrides: Partial<BuildCustomerLiveProgressInput> = {}): BuildCustomerLiveProgressInput {
  return {
    stage: 'PROVISIONING',
    step: 'NETWORK',
    events: [],
    installJobId: '11111111-2222-3333-4444-555555555555',
    stepTimings: null,
    health: NO_HEALTH,
    https: null,
    needsDomainSetup: false,
    launched: true,
    ...overrides,
  };
}

describe('translateStackEvents — success flow', () => {
  const events: StackEventLike[] = [
    event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: at(0) }),
    event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_COMPLETE', eventAt: at(30) }),
    event({ logicalResourceId: 'SubnetA', resourceType: 'AWS::EC2::Subnet', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: at(2) }),
    event({ logicalResourceId: 'SubnetA', resourceType: 'AWS::EC2::Subnet', resourceStatus: 'CREATE_COMPLETE', eventAt: at(35) }),
    event({ logicalResourceId: 'SubnetB', resourceType: 'AWS::EC2::Subnet', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: at(2) }),
    event({ logicalResourceId: 'SubnetB', resourceType: 'AWS::EC2::Subnet', resourceStatus: 'CREATE_COMPLETE', eventAt: at(40) }),
    event({ logicalResourceId: 'Db', resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: at(45) }),
    event({ logicalResourceId: 'Db', resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'CREATE_COMPLETE', eventAt: at(300) }),
    event({ logicalResourceId: 'AppService', resourceType: 'AWS::ECS::Service', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: at(310) }),
    // Noise: never a customer-facing item.
    event({ logicalResourceId: 'TaskRole', resourceType: 'AWS::IAM::Role', resourceStatus: 'CREATE_COMPLETE', eventAt: at(5) }),
    event({ logicalResourceId: 'AppLogs', resourceType: 'AWS::Logs::LogGroup', resourceStatus: 'CREATE_COMPLETE', eventAt: at(6) }),
    event({ logicalResourceId: 'RouteTable', resourceType: 'AWS::EC2::RouteTable', resourceStatus: 'CREATE_COMPLETE', eventAt: at(7) }),
    event({ logicalResourceId: 'TaskDef', resourceType: 'AWS::ECS::TaskDefinition', resourceStatus: 'CREATE_COMPLETE', eventAt: at(8) }),
    event({ logicalResourceId: 'Tg', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', resourceStatus: 'CREATE_COMPLETE', eventAt: at(9) }),
  ];

  it('translates network → database → application, dedupes the two subnets into one item, drops noise, newest first', () => {
    const items = translateStackEvents(events);
    expect(items.map((item) => item.key)).toEqual(['application-service', 'database', 'network-zones', 'network']);
    expect(items[0]).toMatchObject({ state: 'IN_PROGRESS', message: 'Creating the application service.' });
    expect(items[1]).toMatchObject({ state: 'COMPLETE', message: 'Database is ready.' });
    // The two subnets collapse into ONE item, timestamped by the later completion.
    expect(items[2]).toMatchObject({ state: 'COMPLETE', message: 'Network zones is ready.', at: at(40).toISOString() });
    expect(items[3]).toMatchObject({ state: 'COMPLETE', message: 'Private network is ready.' });
    // Newest first.
    for (let i = 0; i < items.length - 1; i += 1) {
      expect(new Date(items[i]!.at).getTime()).toBeGreaterThanOrEqual(new Date(items[i + 1]!.at).getTime());
    }
  });

  it('caps at 5 items when more than 5 nouns are present', () => {
    const many: StackEventLike[] = [
      ...events,
      event({ logicalResourceId: 'Cache', resourceType: 'AWS::ElastiCache::ReplicationGroup', resourceStatus: 'CREATE_COMPLETE', eventAt: at(400) }),
      event({ logicalResourceId: 'Secret', resourceType: 'AWS::SecretsManager::Secret', resourceStatus: 'CREATE_COMPLETE', eventAt: at(500) }),
    ];
    const items = translateStackEvents(many);
    expect(items).toHaveLength(5);
  });
});

describe('translateStackEvents — long-running flow', () => {
  const events: StackEventLike[] = [
    event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_COMPLETE', eventAt: at(30) }),
    event({ logicalResourceId: 'Db', resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'CREATE_COMPLETE', eventAt: at(300) }),
    event({
      logicalResourceId: 'AppService',
      resourceType: 'AWS::ECS::Service',
      resourceStatus: 'CREATE_IN_PROGRESS',
      resourceStatusReason: 'Resource creation Initiated',
      eventAt: at(310),
    }),
  ];

  it('is deterministic: calling twice with no new events returns the same list', () => {
    expect(translateStackEvents(events)).toEqual(translateStackEvents(events));
  });

  it('the ECS service "Resource creation Initiated" reason maps to the waiting-to-become-healthy message', () => {
    const items = translateStackEvents(events);
    const service = items.find((item) => item.key === 'application-service');
    expect(service?.message).toBe('Starting the application. Waiting for it to become healthy.');
  });

  it('currentActivity comes from the newest IN_PROGRESS item', () => {
    const live = buildCustomerLiveProgress(baseLiveInput({ stage: 'PROVISIONING', step: 'APPLICATION', events }));
    expect(live.currentActivity).toBe('Starting the application. Waiting for it to become healthy.');
  });
});

describe('translateStackEvents / findProvisioningIssue — failure flow', () => {
  const genuineReason = 'Password authentication failed for user "app"';
  const events: StackEventLike[] = [
    event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_COMPLETE', eventAt: at(20) }),
    event({ logicalResourceId: 'Db', resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'CREATE_IN_PROGRESS', eventAt: at(30) }),
    event({
      logicalResourceId: 'Db',
      resourceType: 'AWS::RDS::DBInstance',
      resourceStatus: 'CREATE_FAILED',
      resourceStatusReason: genuineReason,
      eventAt: at(60),
    }),
    // Rollback debris on unrelated resources — never a genuine failure.
    event({
      logicalResourceId: 'Secret',
      resourceType: 'AWS::SecretsManager::Secret',
      resourceStatus: 'CREATE_FAILED',
      resourceStatusReason: 'Resource creation cancelled',
      eventAt: at(65),
    }),
    event({
      logicalResourceId: 'Cluster',
      resourceType: 'AWS::ECS::Cluster',
      resourceStatus: 'CREATE_FAILED',
      resourceStatusReason: 'Resource creation cancelled',
      eventAt: at(66),
    }),
    event({ logicalResourceId: 'my-stack', resourceType: 'AWS::CloudFormation::Stack', resourceStatus: 'ROLLBACK_IN_PROGRESS', eventAt: at(70) }),
  ];

  it('produces exactly one FAILED item for the database; debris never becomes an item', () => {
    const items = translateStackEvents(events);
    const failed = items.filter((item) => item.state === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ key: 'database', message: 'Could not create the database.' });
    // The debris-only nouns (secure-credentials, application-environment) never
    // surface as FAILED — or as anything at all, since their only event is debris.
    expect(items.some((item) => item.key === 'secure-credentials')).toBe(false);
    expect(items.some((item) => item.key === 'application-environment')).toBe(false);
  });

  it('findProvisioningIssue names the database and never a debris reason', () => {
    const issue = findProvisioningIssue(events);
    expect(issue).toEqual({
      message: 'AWS could not create the database. Deployz is cleaning up and will show the result here shortly.',
    });
  });

  it('the FAILED stage keeps the raw failing event in technicalDetails, sets no provisioningIssue, and reports cleanup in progress', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({ stage: 'FAILED', step: 'DATABASE_STORAGE', events, installJobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    );
    expect(live.provisioningIssue).toBeNull();
    // The stack row in this fixture is ROLLBACK_IN_PROGRESS: the failed
    // attempt is still being cleaned up.
    expect(live.cleanup).toBe('IN_PROGRESS');
    expect(live.recentActivity).toEqual([]);
    expect(live.technicalDetails).not.toBeNull();
    expect(live.technicalDetails!.reference).toBe('DEP-AAAAAAAA');
    expect(live.technicalDetails).toMatchObject({
      facts: expect.arrayContaining([
        { label: 'Failed resource', value: 'Db' },
        { label: 'Failed status', value: 'CREATE_FAILED' },
        { label: 'Status reason', value: genuineReason },
      ]),
    });
  });

  it('returns null when there is no genuine failure', () => {
    expect(findProvisioningIssue([event({ logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_COMPLETE' })])).toBeNull();
  });
});

describe('buildCustomerLiveProgress — cleanup of a failed install', () => {
  const stackRow = (resourceStatus: string): StackEventLike =>
    event({ logicalResourceId: 'my-stack', resourceType: 'AWS::CloudFormation::Stack', resourceStatus });

  it('a rolling-back stack reports cleanup in progress', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({ stage: 'FAILED', step: 'APPLICATION', events: [stackRow('ROLLBACK_IN_PROGRESS')] }),
    );
    expect(live.cleanup).toBe('IN_PROGRESS');
  });

  it('a deleting stack reports cleanup in progress', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({ stage: 'FAILED', step: 'APPLICATION', events: [stackRow('DELETE_IN_PROGRESS')] }),
    );
    expect(live.cleanup).toBe('IN_PROGRESS');
  });

  it('a terminally failed stack reports that resources may remain', () => {
    const rolledBack = buildCustomerLiveProgress(
      baseLiveInput({ stage: 'FAILED', step: 'APPLICATION', events: [stackRow('ROLLBACK_COMPLETE')] }),
    );
    expect(rolledBack.cleanup).toBe('RETAINED');
    const createFailed = buildCustomerLiveProgress(
      baseLiveInput({ stage: 'FAILED', step: 'APPLICATION', events: [stackRow('CREATE_FAILED')] }),
    );
    expect(createFailed.cleanup).toBe('RETAINED');
  });

  it('a verified cleanup outranks the stack status', () => {
    const live = buildCustomerLiveProgress({
      ...baseLiveInput({ stage: 'FAILED', step: 'APPLICATION', events: [stackRow('ROLLBACK_COMPLETE')] }),
      cleanupState: 'COMPLETE',
    });
    expect(live.cleanup).toBe('COMPLETE');
  });

  it('no stack row and no verified cleanup means nothing to say', () => {
    const live = buildCustomerLiveProgress(baseLiveInput({ stage: 'FAILED', step: 'APPLICATION', events: [] }));
    expect(live.cleanup).toBeNull();
  });

  it('a non-FAILED stage never reports cleanup', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({ stage: 'PROVISIONING', step: 'APPLICATION', events: [stackRow('ROLLBACK_IN_PROGRESS')] }),
    );
    expect(live.cleanup).toBeNull();
  });
});

describe('buildCustomerLiveProgress — HEALTH_CHECK', () => {
  it('a rollout in progress reports "Starting the application."', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({
        stage: 'VERIFYING',
        step: 'HEALTH_CHECK',
        health: { ...NO_HEALTH, rollout: 'IN_PROGRESS' },
      }),
    );
    expect(live.currentActivity).toBe('Starting the application.');
  });

  it('tasks running but no healthy target reports "Waiting for the application to become healthy."', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({
        stage: 'VERIFYING',
        step: 'HEALTH_CHECK',
        health: {
          ...NO_HEALTH,
          rollout: 'COMPLETED',
          targets: { desiredCount: 2, runningCount: 2, unhealthyTargetCount: 2, pendingTargetCount: 0, unknownTargetCount: 0 },
        },
      }),
    );
    expect(live.currentActivity).toBe('Waiting for the application to become healthy.');
  });

  it('falls back to no override when the layers say nothing', () => {
    const live = buildCustomerLiveProgress(baseLiveInput({ stage: 'VERIFYING', step: 'HEALTH_CHECK', health: NO_HEALTH }));
    expect(live.currentActivity).toBeUndefined();
  });

  it('recentActivity carries real completed-step facts, newest first, max 5', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({
        stage: 'VERIFYING',
        step: 'HEALTH_CHECK',
        stepTimings: {
          NETWORK: { startedAt: at(0).toISOString(), completedAt: at(60).toISOString() },
          DATABASE_STORAGE: { startedAt: at(60).toISOString(), completedAt: at(180).toISOString() },
          APPLICATION: { startedAt: at(180).toISOString(), completedAt: at(300).toISOString() },
        },
      }),
    );
    expect(live.recentActivity.map((item) => item.message)).toEqual([
      'Application started.',
      'Database and storage are ready.',
      'Network is ready.',
    ]);
  });

  it('technicalDetails.facts report the raw rollout/target/probe state', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({
        stage: 'VERIFYING',
        step: 'HEALTH_CHECK',
        health: {
          ...NO_HEALTH,
          rollout: 'IN_PROGRESS',
          targets: { desiredCount: 2, runningCount: 1, unhealthyTargetCount: 0, pendingTargetCount: 1, unknownTargetCount: 0 },
          http: { ok: false, statusCode: null, latencyMs: null, checkedAt: at(0).toISOString(), error: 'timeout' },
        },
      }),
    );
    expect(live.technicalDetails).toMatchObject({
      facts: expect.arrayContaining([
        { label: 'Rollout state', value: 'IN_PROGRESS' },
        { label: 'Running tasks', value: '1' },
        { label: 'Desired tasks', value: '2' },
        { label: 'Probe status', value: 'timeout' },
      ]),
      events: [],
    });
  });
});

describe('buildCustomerLiveProgress — TLS', () => {
  it('maps PENDING/WAITING_FOR_DNS/CONFIGURING to their copy', () => {
    const statuses: [string, string][] = [
      ['PENDING', 'Requesting the HTTPS certificate.'],
      ['WAITING_FOR_DNS', 'Validating the domain. Waiting for AWS certificate validation.'],
      ['CONFIGURING', 'Attaching the certificate. Waiting for the HTTPS endpoint.'],
    ];
    for (const [status, expected] of statuses) {
      const live = buildCustomerLiveProgress(
        baseLiveInput({
          stage: 'VERIFYING',
          step: 'TLS',
          https: { hostname: 'd-abc.deployz.dev', status, lastError: null, lastCheckedAt: null },
        }),
      );
      expect(live.currentActivity).toBe(expected);
    }
  });

  it('needsDomainSetup true leaves currentActivity undefined — the customer must act', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({
        stage: 'VERIFYING',
        step: 'TLS',
        needsDomainSetup: true,
        https: { hostname: 'app.customer.example.com', status: 'WAITING_FOR_DNS', lastError: null, lastCheckedAt: null },
      }),
    );
    expect(live.currentActivity).toBeUndefined();
  });

  it('recentActivity includes the health-check completion and the last DNS check', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({
        stage: 'VERIFYING',
        step: 'TLS',
        stepTimings: { HEALTH_CHECK: { startedAt: at(0).toISOString(), completedAt: at(60).toISOString() } },
        https: { hostname: 'd-abc.deployz.dev', status: 'WAITING_FOR_DNS', lastError: null, lastCheckedAt: at(120).toISOString() },
      }),
    );
    expect(live.recentActivity.map((item) => item.message)).toEqual(['Checked the domain records.', 'Application passed health checks.']);
  });

  it('technicalDetails.facts never leak an ARN or validation token, only hostname/status/error/last-check', () => {
    const live = buildCustomerLiveProgress(
      baseLiveInput({
        stage: 'VERIFYING',
        step: 'TLS',
        https: { hostname: 'd-abc.deployz.dev', status: 'ERROR', lastError: 'DEFAULT_DNS_TIMEOUT', lastCheckedAt: at(120).toISOString() },
      }),
    );
    expect(live.technicalDetails).toEqual({
      reference: 'DEP-11111111',
      facts: [
        { label: 'Hostname', value: 'd-abc.deployz.dev' },
        { label: 'HTTPS status', value: 'ERROR' },
        { label: 'Last error', value: 'DEFAULT_DNS_TIMEOUT' },
        { label: 'Last DNS check', value: at(120).toISOString() },
      ],
      events: [],
    });
  });
});

describe('buildCustomerLiveProgress — quiet stages', () => {
  const nothing = { recentActivity: [], provisioningIssue: null, cleanup: null, technicalDetails: null };

  it('READY and a link that is not launched report nothing', () => {
    expect(buildCustomerLiveProgress(baseLiveInput({ stage: 'READY', step: 'READY' }))).toEqual(nothing);
    expect(
      buildCustomerLiveProgress(baseLiveInput({ stage: 'WAITING_FOR_AWS', step: 'AWS_SETUP', launched: false })),
    ).toEqual(nothing);
  });

  it('a launched WAITING_FOR_AWS says AWS is at work, with no events', () => {
    const live = buildCustomerLiveProgress(baseLiveInput({ stage: 'WAITING_FOR_AWS', step: 'AWS_SETUP' }));
    expect(live).toEqual({
      ...nothing,
      currentActivity: 'AWS is creating the Deployz connector in your account.',
    });
  });

  it('CONNECTING uses customer wording, with no events', () => {
    const live = buildCustomerLiveProgress(baseLiveInput({ stage: 'CONNECTING', step: 'RELAY_CONNECT' }));
    expect(live).toEqual({
      ...nothing,
      currentActivity: 'The connector is ready. Deployz is preparing the deployment.',
    });
  });
});

describe('jargon guard', () => {
  // §65: never raw AWS/CFN jargon or a raw status token in customer copy.
  const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS|S3|ElastiCache|ACM)\b|[A-Z]+_[A-Z_]+/;

  it('no translated message, issue, or currentActivity ever matches the jargon pattern', () => {
    const allTypes = [
      'AWS::EC2::VPC',
      'AWS::EC2::Subnet',
      'AWS::EC2::NatGateway',
      'AWS::RDS::DBInstance',
      'AWS::S3::Bucket',
      'AWS::ElastiCache::ReplicationGroup',
      'AWS::SecretsManager::Secret',
      'AWS::ECS::Cluster',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ECS::Service',
      'AWS::CloudFormation::Stack',
    ];
    const statuses = ['CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'CREATE_FAILED', 'DELETE_IN_PROGRESS', 'DELETE_COMPLETE', 'ROLLBACK_IN_PROGRESS'];
    const messages: string[] = [];
    for (const resourceType of allTypes) {
      for (const resourceStatus of statuses) {
        const items = translateStackEvents([
          event({ logicalResourceId: 'Resource1', resourceType, resourceStatus, resourceStatusReason: 'Some real reason', eventAt: at(0) }),
        ]);
        for (const item of items) messages.push(item.message);
        const issue = findProvisioningIssue([
          event({ logicalResourceId: 'Resource1', resourceType, resourceStatus: 'CREATE_FAILED', resourceStatusReason: 'Some real reason', eventAt: at(0) }),
        ]);
        if (issue) messages.push(issue.message);
      }
    }
    const health = buildCustomerLiveProgress(
      baseLiveInput({ stage: 'VERIFYING', step: 'HEALTH_CHECK', health: { ...NO_HEALTH, rollout: 'IN_PROGRESS' } }),
    );
    if (health.currentActivity) messages.push(health.currentActivity);
    const tls = buildCustomerLiveProgress(
      baseLiveInput({ stage: 'VERIFYING', step: 'TLS', https: { hostname: 'x', status: 'CONFIGURING', lastError: null, lastCheckedAt: null } }),
    );
    if (tls.currentActivity) messages.push(tls.currentActivity);

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toMatch(JARGON);
    }
  });
});

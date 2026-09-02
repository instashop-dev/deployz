import { describe, expect, it, vi } from 'vitest';

import {
  createPurgeExecutor,
  createPurgeResumer,
  isAccessDenied,
  settlePurge,
  toNetworkPurgeClient,
  type CachePurgeClient,
  type NetworkPurgeClient,
  type PurgeDeps,
  type RdsPurgeClient,
  type S3PurgeClient,
  type SecretsPurgeClient,
} from './purge.js';
import { memoryPendingStore } from './pending.js';
import type { WaitOptions } from './recover.js';
import type { StackDeleter } from './destroy.js';
import type { CloudFormationReader, StackLookup, StackResource } from './verify.js';

const INSTALLATION_ID = 'inst-purge-test';
const APP_STACK = 'deployz-app';
const BOOTSTRAP_STACK = 'deployz-bootstrap';
const NO_SLEEP: WaitOptions = { pollIntervalMs: 0, maxAttempts: 3, sleep: async () => {} };

function appStack(status: string, installationId = INSTALLATION_ID): StackLookup {
  return {
    found: true,
    stack: { stackName: APP_STACK, status, tags: { 'deployz:installation': installationId } },
  };
}

function bootstrapStack(status = 'CREATE_COMPLETE', installationId = INSTALLATION_ID): StackLookup {
  return {
    found: true,
    stack: {
      stackName: BOOTSTRAP_STACK,
      status,
      tags: { 'deployz:installation': installationId },
    },
  };
}

function command() {
  return {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'PURGE' as const,
    idempotencyKey: 'key-1',
    payload: {},
  };
}

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakedClients {
  calls: string[];
  rds: RdsPurgeClient;
  cache: CachePurgeClient;
  s3: S3PurgeClient;
  secrets: SecretsPurgeClient;
  network: NetworkPurgeClient;
  deleter: StackDeleter;
}

function clients(calls: string[], owned: {
  instances?: { identifier: string; status: string }[];
  groups?: { identifier: string; status: string }[];
  buckets?: string[];
  secrets?: string[];
  subnetGroups?: string[];
  vpcs?: string[];
  securityGroups?: string[];
  subnets?: string[];
  routeTables?: string[];
  internetGateways?: string[];
  natGateways?: string[];
} = {}): FakedClients {
  const rds: RdsPurgeClient = {
    async listOwnedInstances() {
      return owned.instances ?? [];
    },
    async disableDeletionProtection(identifier) {
      calls.push(`rds:unprotect:${identifier}`);
    },
    async deleteInstance(identifier) {
      calls.push(`rds:delete:${identifier}`);
    },
    async listOwnedSubnetGroups() {
      return owned.subnetGroups ?? [];
    },
    async deleteSubnetGroup(name) {
      calls.push(`rds:delete-subnet-group:${name}`);
    },
  };
  const network: NetworkPurgeClient = {
    async listOwnedVpcs() {
      return owned.vpcs ?? [];
    },
    async listOwnedSecurityGroups() {
      return owned.securityGroups ?? [];
    },
    async deleteSecurityGroup(groupId) {
      calls.push(`network:delete-sg:${groupId}`);
    },
    async listOwnedSubnets() {
      return owned.subnets ?? [];
    },
    async deleteSubnet(subnetId) {
      calls.push(`network:delete-subnet:${subnetId}`);
    },
    async listOwnedRouteTables() {
      return owned.routeTables ?? [];
    },
    async deleteRouteTable(routeTableId) {
      calls.push(`network:delete-route-table:${routeTableId}`);
    },
    async listOwnedInternetGateways() {
      return owned.internetGateways ?? [];
    },
    async detachInternetGateway(gatewayId) {
      calls.push(`network:detach-igw:${gatewayId}`);
    },
    async deleteInternetGateway(gatewayId) {
      calls.push(`network:delete-igw:${gatewayId}`);
    },
    async listOwnedNatGateways() {
      return owned.natGateways ?? [];
    },
    async deleteNatGateway(natGatewayId) {
      calls.push(`network:delete-nat:${natGatewayId}`);
    },
    async deleteVpc(vpcId) {
      calls.push(`network:delete-vpc:${vpcId}`);
    },
  };
  const cache: CachePurgeClient = {
    async listOwnedReplicationGroups() {
      return owned.groups ?? [];
    },
    async deleteReplicationGroup(identifier) {
      calls.push(`cache:delete:${identifier}`);
    },
  };
  const s3: S3PurgeClient = {
    async listOwnedBuckets() {
      return owned.buckets ?? [];
    },
    async emptyBucket(bucketName) {
      calls.push(`s3:empty:${bucketName}`);
    },
    async deleteBucket(bucketName) {
      calls.push(`s3:delete:${bucketName}`);
    },
  };
  const secrets: SecretsPurgeClient = {
    async listOwnedSecrets() {
      return owned.secrets ?? [];
    },
    async deleteSecret(secretName) {
      calls.push(`secrets:delete:${secretName}`);
    },
  };
  const deleter: StackDeleter = {
    async deleteStack(stackName) {
      calls.push(`stack:delete:${stackName}`);
    },
  };
  return { calls, rds, cache, s3, secrets, network, deleter };
}

function depsWith(cfn: CloudFormationReader, calls: string[], extra: Partial<PurgeDeps> = {}): PurgeDeps {
  const faked = clients(calls);
  return {
    cfn,
    deleter: faked.deleter,
    pending: memoryPendingStore(),
    installationId: INSTALLATION_ID,
    stackName: APP_STACK,
    bootstrapStackName: BOOTSTRAP_STACK,
    rds: faked.rds,
    cache: faked.cache,
    s3: faked.s3,
    secrets: faked.secrets,
    network: faked.network,
    ...extra,
  };
}

// ── settlePurge: application stack ───────────────────────────────────────

describe('settlePurge — application stack phase', () => {
  it('deletes a tagged, present application stack and waits (deferred)', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          return stackName === APP_STACK ? appStack('CREATE_COMPLETE') : { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual([`stack:delete:${APP_STACK}`]);
  });

  it('refuses an application stack that does not carry this installation tag', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          return stackName === APP_STACK ? appStack('CREATE_COMPLETE', 'someone-else') : { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({
      state: 'failed',
      reason: `Stack "${APP_STACK}" does not carry this installation's tag — refusing to purge`,
    });
    expect(calls).toEqual([]);
  });

  it('waits on a stack already DELETE_IN_PROGRESS without re-deleting', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          return stackName === APP_STACK ? appStack('DELETE_IN_PROGRESS') : { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual([]);
  });

  it('clears DELETE_FAILED orphans outright (purge authorizes data deletion) and waits for the retry', async () => {
    const calls: string[] = [];
    const resources: StackResource[] = [
      {
        logicalId: 'Database',
        type: 'AWS::RDS::DBInstance',
        status: 'DELETE_FAILED',
        physicalId: 'deployz-app-database-1a2b3c',
      },
    ];
    let appLookups = 0;
    const deps = depsWith(
      {
        async describeStack(stackName) {
          if (stackName !== APP_STACK) return { found: false };
          appLookups += 1;
          // First lookup: DELETE_FAILED; the retry's poll then sees deletion.
          return appLookups === 1 ? appStack('DELETE_FAILED') : appStack('DELETE_IN_PROGRESS');
        },
        async describeStackResources() {
          return resources;
        },
      },
      calls,
      { wait: NO_SLEEP },
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toContain('rds:delete:deployz-app-database-1a2b3c');
    expect(calls).toContain(`stack:delete:${APP_STACK}`);
  });
});

// ── settlePurge: owned orphans ────────────────────────────────────────────

describe('settlePurge — orphan sweep', () => {
  function cfnAppAbsent(): CloudFormationReader {
    return {
      async describeStack() {
        return { found: false };
      },
      async describeStackResources() {
        return [];
      },
    };
  }

  it('initiates owned RDS deletion and waits', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      rds: clients(calls, {
        instances: [{ identifier: 'db-1', status: 'available' }],
      }).rds,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['rds:unprotect:db-1', 'rds:delete:db-1']);
  });

  it('waits on an RDS instance already deleting instead of re-deleting it', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      rds: clients(calls, {
        instances: [{ identifier: 'db-1', status: 'deleting' }],
      }).rds,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual([]);
  });

  it('moves on to owned cache groups once no RDS instance remains', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      cache: clients(calls, {
        groups: [{ identifier: 'cache-1', status: 'available' }],
      }).cache,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['cache:delete:cache-1']);
  });

  it('empties and deletes owned buckets once no RDS or cache remains', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      s3: clients(calls, { buckets: ['bucket-1'] }).s3,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['s3:empty:bucket-1', 's3:delete:bucket-1']);
  });

  it('deletes owned retained DB-credential secrets once no RDS, cache, or bucket remains', async () => {
    // Phase 9 retained-credential behavior: a PURGE must sweep the secrets
    // that were RETAINed with the database (so a disconnect never strands a
    // retained database without its password). Once the database itself is
    // gone these secrets are dead credentials — delete them.
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      secrets: clients(calls, {
        secrets: ['DatabaseSecret-ABC', 'DatabaseUrlSecret-DEF'],
      }).secrets,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['secrets:delete:DatabaseSecret-ABC', 'secrets:delete:DatabaseUrlSecret-DEF']);
  });

  it('leaves the retained DB-credential secrets untouched while the retained database is still being deleted', async () => {
    // Ordering guarantee: the credential sweep must not run on the same pass
    // that still sees an owned RDS instance — the secrets stay reachable for
    // the retained database until the database deletion is done.
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      ...clients(calls, {
        instances: [{ identifier: 'db-1', status: 'available' }],
        secrets: ['DatabaseSecret-ABC'],
      }),
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['rds:unprotect:db-1', 'rds:delete:db-1']);
    expect(calls).not.toContain('secrets:delete:DatabaseSecret-ABC');
  });
});

// ── settlePurge: orphaned network sweep (CANARY-015) ───────────────────────

describe('settlePurge — orphaned network sweep (CANARY-015)', () => {
  function cfnAppAbsent(): CloudFormationReader {
    return {
      async describeStack() {
        return { found: false };
      },
      async describeStackResources() {
        return [];
      },
    };
  }

  it('deletes the RETAIN-ed RDS subnet group once no RDS/cache/S3/secrets orphan remains', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      rds: clients(calls, { subnetGroups: ['deployz-app-databasesubnetgroup'] }).rds,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['rds:delete-subnet-group:deployz-app-databasesubnetgroup']);
  });

  it('keeps the purge `purging` (not failed) when the subnet group is still referenced by a DB instance', async () => {
    const calls: string[] = [];
    const inUse = Object.assign(new Error('still has instances'), {
      name: 'InvalidDBSubnetGroupStateFault',
    });
    const deps = depsWith(cfnAppAbsent(), calls, {
      rds: {
        ...clients(calls).rds,
        async listOwnedSubnetGroups() {
          return ['deployz-app-databasesubnetgroup'];
        },
        async deleteSubnetGroup() {
          throw inUse;
        },
      },
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
  });

  it('deletes owned security groups, then subnets, then the VPC once the subnet group is gone', async () => {
    const calls: string[] = [];
    const base = clients(calls, { vpcs: ['vpc-1'], securityGroups: ['sg-1'] });
    const deps = depsWith(cfnAppAbsent(), calls, { network: base.network });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['network:delete-sg:sg-1']);
  });

  it('moves on to subnets once no owned security group remains', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      network: clients(calls, { vpcs: ['vpc-1'], subnets: ['subnet-1'] }).network,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['network:delete-subnet:subnet-1']);
  });

  it('deletes the VPC once no security group, subnet, route table, or gateway remains', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      network: clients(calls, { vpcs: ['vpc-1'] }).network,
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual(['network:delete-vpc:vpc-1']);
  });

  it('falls through to the bootstrap stack once no owned VPC remains', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          if (stackName === APP_STACK) return { found: false };
          return bootstrapStack();
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'succeeded' });
    expect(calls).toEqual([]);
  });

  it('keeps the purge `purging`, not failed, on a DependencyViolation deleting a security group', async () => {
    const calls: string[] = [];
    const dependencyViolation = Object.assign(new Error('still referenced'), {
      name: 'DependencyViolation',
    });
    const deps = depsWith(cfnAppAbsent(), calls, {
      network: {
        ...clients(calls).network,
        async listOwnedVpcs() {
          return ['vpc-1'];
        },
        async listOwnedSecurityGroups() {
          return ['sg-1'];
        },
        async deleteSecurityGroup() {
          throw dependencyViolation;
        },
      },
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
  });

  it('retries a security group blocked by a sibling rule once within the same pass', async () => {
    // A security group referenced by another security group's own rule fails
    // its first delete attempt and clears once its sibling is gone — the
    // sweep gives it one more try in the same pass rather than waiting a
    // full extra poll cycle.
    const calls: string[] = [];
    const dependencyViolation = Object.assign(new Error('still referenced'), {
      name: 'DependencyViolation',
    });
    let sgAAttempts = 0;
    const deps = depsWith(cfnAppAbsent(), calls, {
      network: {
        ...clients(calls).network,
        async listOwnedVpcs() {
          return ['vpc-1'];
        },
        async listOwnedSecurityGroups() {
          return ['sg-a', 'sg-b'];
        },
        async deleteSecurityGroup(groupId) {
          if (groupId === 'sg-a') {
            sgAAttempts += 1;
            if (sgAAttempts === 1) throw dependencyViolation;
          }
          calls.push(`network:delete-sg:${groupId}`);
        },
      },
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(sgAAttempts).toBe(2);
    expect(calls).toEqual(['network:delete-sg:sg-b', 'network:delete-sg:sg-a']);
  });

  it('sweeps route tables, internet gateways, and NAT gateways only when present, detaching the gateway first', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnAppAbsent(), calls, {
      network: {
        ...clients(calls).network,
        async listOwnedVpcs() {
          return ['vpc-1'];
        },
        async listOwnedRouteTables() {
          return ['rtb-1'];
        },
        async deleteRouteTable(routeTableId) {
          calls.push(`network:delete-route-table:${routeTableId}`);
        },
        async listOwnedInternetGateways() {
          return ['igw-1'];
        },
        async detachInternetGateway(gatewayId) {
          calls.push(`network:detach-igw:${gatewayId}`);
        },
        async deleteInternetGateway(gatewayId) {
          calls.push(`network:delete-igw:${gatewayId}`);
        },
        async listOwnedNatGateways() {
          return ['nat-1'];
        },
        async deleteNatGateway(natGatewayId) {
          calls.push(`network:delete-nat:${natGatewayId}`);
        },
      },
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
    expect(calls).toEqual([
      'network:delete-route-table:rtb-1',
      'network:detach-igw:igw-1',
      'network:delete-igw:igw-1',
      'network:delete-nat:nat-1',
    ]);
  });

  it('keeps the purge `purging` on a DependencyViolation while a gateway is still detaching', async () => {
    const calls: string[] = [];
    const dependencyViolation = Object.assign(new Error('still detaching'), {
      name: 'DependencyViolation',
    });
    const deps = depsWith(cfnAppAbsent(), calls, {
      network: {
        ...clients(calls).network,
        async listOwnedVpcs() {
          return ['vpc-1'];
        },
        async listOwnedInternetGateways() {
          return ['igw-1'];
        },
        async detachInternetGateway() {
          throw dependencyViolation;
        },
      },
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
  });

  it('keeps the purge `purging` on a DependencyViolation deleting the VPC itself', async () => {
    const calls: string[] = [];
    const dependencyViolation = Object.assign(new Error('still has dependencies'), {
      name: 'DependencyViolation',
    });
    const deps = depsWith(cfnAppAbsent(), calls, {
      network: {
        ...clients(calls).network,
        async listOwnedVpcs() {
          return ['vpc-1'];
        },
        async deleteVpc() {
          throw dependencyViolation;
        },
      },
    });

    const outcome = await settlePurge(deps);
    expect(outcome).toEqual({ state: 'purging' });
  });
});

// ── settlePurge: bootstrap stack, last ────────────────────────────────────

describe('settlePurge — bootstrap stack, last', () => {
  function cfnSweptClean(bootstrap: StackLookup | { found: false }): CloudFormationReader {
    return {
      async describeStack(stackName) {
        if (stackName === APP_STACK) return { found: false };
        return bootstrap;
      },
      async describeStackResources() {
        return [];
      },
    };
  }

  it('leaves the bootstrap stack to the customer: no describe, no delete, one honest log line (CANARY-014)', async () => {
    // The relay's CloudFormation grants are tag-conditioned on an id the
    // bootstrap stack can never carry and a stack cannot delete its own
    // execution role, so the old describe-then-delete was AccessDenied on
    // every real install and silently reported as "already gone".
    const calls: string[] = [];
    const describeCalls: string[] = [];
    const cfn = cfnSweptClean(bootstrapStack());
    const spied: CloudFormationReader = {
      ...cfn,
      async describeStack(stackName) {
        describeCalls.push(stackName);
        return cfn.describeStack(stackName);
      },
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outcome = await settlePurge(depsWith(spied, calls));

    expect(outcome).toEqual({ state: 'succeeded' });
    expect(calls).toEqual([]);
    expect(describeCalls).not.toContain(BOOTSTRAP_STACK);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'relay:purge-bootstrap-retained',
        installationId: INSTALLATION_ID,
        bootstrapStackName: BOOTSTRAP_STACK,
      }),
    );
    logSpy.mockRestore();
  });
});

// ── Full purge across passes: idempotent, bootstrap last ──────────────────

describe('full purge across passes', () => {
  interface World {
    calls: string[];
    deps: PurgeDeps;
    setAppStack(status: string | null): void;
    setBootstrap(status: string | null): void;
  }

  function world(): World {
    const calls: string[] = [];
    const state = {
      app: 'CREATE_COMPLETE' as string | null,
      bootstrap: 'CREATE_COMPLETE' as string | null,
      instances: [{ identifier: 'db-1', status: 'available' }],
      groups: [{ identifier: 'cache-1', status: 'available' }],
      buckets: ['bucket-1'],
      secrets: ['DatabaseSecret-ABC', 'DatabaseUrlSecret-DEF'],
      subnetGroups: ['deployz-app-databasesubnetgroup'],
      vpcs: ['vpc-1'],
      securityGroups: ['sg-1'],
      subnets: ['subnet-1'],
    };
    const cfn: CloudFormationReader = {
      async describeStack(stackName) {
        const status = stackName === APP_STACK ? state.app : state.bootstrap;
        if (status === null) return { found: false };
        return {
          found: true,
          stack: {
            stackName,
            status,
            tags: { 'deployz:installation': INSTALLATION_ID },
          },
        };
      },
      async describeStackResources() {
        return [];
      },
    };
    const rds: RdsPurgeClient = {
      async listOwnedInstances() {
        return [...state.instances];
      },
      async disableDeletionProtection(identifier) {
        calls.push(`rds:unprotect:${identifier}`);
      },
      async deleteInstance(identifier) {
        calls.push(`rds:delete:${identifier}`);
        state.instances = [];
      },
      async listOwnedSubnetGroups() {
        return [...state.subnetGroups];
      },
      async deleteSubnetGroup(name) {
        calls.push(`rds:delete-subnet-group:${name}`);
        state.subnetGroups = [];
      },
    };
    const network: NetworkPurgeClient = {
      async listOwnedVpcs() {
        return [...state.vpcs];
      },
      async listOwnedSecurityGroups() {
        return [...state.securityGroups];
      },
      async deleteSecurityGroup(groupId) {
        calls.push(`network:delete-sg:${groupId}`);
        state.securityGroups = [];
      },
      async listOwnedSubnets() {
        return [...state.subnets];
      },
      async deleteSubnet(subnetId) {
        calls.push(`network:delete-subnet:${subnetId}`);
        state.subnets = [];
      },
      async listOwnedRouteTables() {
        return [];
      },
      async deleteRouteTable() {},
      async listOwnedInternetGateways() {
        return [];
      },
      async detachInternetGateway() {},
      async deleteInternetGateway() {},
      async listOwnedNatGateways() {
        return [];
      },
      async deleteNatGateway() {},
      async deleteVpc(vpcId) {
        calls.push(`network:delete-vpc:${vpcId}`);
        state.vpcs = [];
      },
    };
    const cache: CachePurgeClient = {
      async listOwnedReplicationGroups() {
        return [...state.groups];
      },
      async deleteReplicationGroup(identifier) {
        calls.push(`cache:delete:${identifier}`);
        state.groups = [];
      },
    };
    const s3: S3PurgeClient = {
      async listOwnedBuckets() {
        return [...state.buckets];
      },
      async emptyBucket(bucketName) {
        calls.push(`s3:empty:${bucketName}`);
      },
      async deleteBucket(bucketName) {
        calls.push(`s3:delete:${bucketName}`);
        state.buckets = [];
      },
    };
    const secrets: SecretsPurgeClient = {
      async listOwnedSecrets() {
        return [...state.secrets];
      },
      async deleteSecret(secretName) {
        calls.push(`secrets:delete:${secretName}`);
        state.secrets = [];
      },
    };
    const deleter: StackDeleter = {
      async deleteStack(stackName) {
        calls.push(`stack:delete:${stackName}`);
        if (stackName === APP_STACK) state.app = 'DELETE_IN_PROGRESS';
        if (stackName === BOOTSTRAP_STACK) state.bootstrap = 'DELETE_IN_PROGRESS';
      },
    };
    return {
      calls,
      deps: {
        cfn,
        deleter,
        pending: memoryPendingStore(),
        installationId: INSTALLATION_ID,
        stackName: APP_STACK,
        bootstrapStackName: BOOTSTRAP_STACK,
        rds,
        cache,
        s3,
        secrets,
        network,
      },
      setAppStack(status) {
        state.app = status;
      },
      setBootstrap(status) {
        state.bootstrap = status;
      },
    };
  }

  it('makes forward progress each pass, sweeps the network orphans, and removes the bootstrap stack last', async () => {
    const w = world();

    // Pass 1: application stack present — delete it, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // CloudFormation finishes the stack delete between polls.
    w.setAppStack(null);

    // Pass 2: owned RDS instance — unprotect, delete, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 3: owned cache — delete, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 4: owned bucket — empty, delete, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 5: owned retained DB-credential secrets — delete, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 6: RETAIN-ed RDS subnet group (CANARY-015) — delete, wait.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 7: orphaned VPC network (CANARY-015) — security group first.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 8: — then the subnet.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 9: — no route tables/gateways present, so the VPC itself, last.
    expect(await settlePurge(w.deps)).toEqual({ state: 'purging' });
    // Pass 10: everything swept — the bootstrap stack stays for the customer.
    expect(await settlePurge(w.deps)).toEqual({ state: 'succeeded' });

    expect(w.calls).toEqual([
      `stack:delete:${APP_STACK}`,
      'rds:unprotect:db-1',
      'rds:delete:db-1',
      'cache:delete:cache-1',
      's3:empty:bucket-1',
      's3:delete:bucket-1',
      'secrets:delete:DatabaseSecret-ABC',
      'secrets:delete:DatabaseUrlSecret-DEF',
      'rds:delete-subnet-group:deployz-app-databasesubnetgroup',
      'network:delete-sg:sg-1',
      'network:delete-subnet:subnet-1',
      'network:delete-vpc:vpc-1',
    ]);
    // The bootstrap stack is the customer's to delete (CANARY-014).
    expect(w.calls).not.toContain(`stack:delete:${BOOTSTRAP_STACK}`);

    // Re-running the completed purge is a clean no-op (idempotent retry).
    w.setBootstrap(null);
    w.calls.length = 0;
    expect(await settlePurge(w.deps)).toEqual({ state: 'succeeded' });
    expect(w.calls).toEqual([]);
  });
});

// ── Executor + resumer ───────────────────────────────────────────────────

describe('createPurgeExecutor', () => {
  function cfnReturning(app: StackLookup | { found: false }, bootstrap: StackLookup | { found: false }): CloudFormationReader {
    return {
      async describeStack(stackName) {
        return stackName === APP_STACK ? app : bootstrap;
      },
      async describeStackResources() {
        return [];
      },
    };
  }

  it('reports success with purged output when everything is already gone', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnReturning({ found: false }, { found: false }), calls);
    const result = await createPurgeExecutor(deps)(command());

    expect(result).toEqual({
      commandId: 'cmd-1',
      idempotencyKey: 'key-1',
      success: true,
      output: { executed: true, type: 'PURGE', purged: true, connectorStackRetained: BOOTSTRAP_STACK },
    });
    expect(calls).toEqual([]);
  });

  it('defers while deletions are in flight and records the pending debt', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnReturning(appStack('CREATE_COMPLETE'), { found: false }), calls);
    const result = await createPurgeExecutor(deps)(command());

    expect(result).toEqual({
      commandId: 'cmd-1',
      idempotencyKey: 'key-1',
      success: false,
      deferred: true,
    });
    const pending = await deps.pending.read();
    expect(pending?.type).toBe('PURGE');
    expect(pending?.commandId).toBe('cmd-1');
  });

  it('fails when the pending debt cannot be recorded', async () => {
    const calls: string[] = [];
    const deps = depsWith(cfnReturning(appStack('CREATE_COMPLETE'), { found: false }), calls, {
      pending: {
        async read() {
          return null;
        },
        async write() {
          return false;
        },
        async clear() {
          return true;
        },
      },
    });
    const result = await createPurgeExecutor(deps)(command());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('could not record');
    }
  });

  it('maps a tag refusal to a STACK_DELETE_FAILED failure', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      cfnReturning(appStack('CREATE_COMPLETE', 'someone-else'), { found: false }),
      calls,
    );
    const result = await createPurgeExecutor(deps)(command());

    expect(result).toMatchObject({
      success: false,
      failureCode: 'STACK_DELETE_FAILED',
    });
    expect(calls).toEqual([]);
  });

  it('classifies a permission failure on an orphan tag read as retryable AWS_PERMISSION_DENIED, never as purge success', async () => {
    // Phase 5 §9.1: an AccessDenied while READING ownership must fail the
    // purge retryably. Swallowing it (the old behavior) reported
    // `purged: true` while every retained resource still existed — the
    // control plane then cleared the retained-resources warning.
    const accessDenied = Object.assign(new Error('Access denied'), {
      name: 'AccessDenied',
      code: 'AccessDenied',
    });
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
      {
        rds: {
          async listOwnedInstances() {
            throw accessDenied;
          },
          async disableDeletionProtection() {},
          async deleteInstance() {},
        },
      },
    );
    // isAccessDenied itself distinguishes the two error classes.
    expect(isAccessDenied(accessDenied)).toBe(true);
    expect(isAccessDenied(Object.assign(new Error('gone'), { name: 'NoSuchTagSet' }))).toBe(false);

    const result = await createPurgeExecutor(deps)(command());
    expect(result).toMatchObject({
      success: false,
      failureCode: 'AWS_PERMISSION_DENIED',
    });
    expect(calls).toEqual([]);
  });

  it('classifies a permission failure while reading owned retained secrets as retryable AWS_PERMISSION_DENIED', async () => {
    // Phase 9: the retained-credential sweep follows the same rule as every
    // other orphan read — an access-denied while verifying secret ownership
    // must fail the purge retryably, never report `purged: true`.
    const accessDenied = Object.assign(new Error('Access denied'), {
      name: 'AccessDenied',
      code: 'AccessDenied',
    });
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
      {
        secrets: {
          async listOwnedSecrets() {
            throw accessDenied;
          },
          async deleteSecret() {},
        },
      },
    );

    const result = await createPurgeExecutor(deps)(command());
    expect(result).toMatchObject({
      success: false,
      failureCode: 'AWS_PERMISSION_DENIED',
    });
    expect(calls).toEqual([]);
  });

  it('classifies a permission failure while reading owned RDS subnet groups as retryable AWS_PERMISSION_DENIED', async () => {
    // CANARY-015: same rule as every other orphan read — an access-denied
    // while verifying subnet-group ownership must fail the purge retryably.
    const accessDenied = Object.assign(new Error('Access denied'), {
      name: 'AccessDenied',
      code: 'AccessDenied',
    });
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
      {
        rds: {
          ...clients(calls).rds,
          async listOwnedSubnetGroups() {
            throw accessDenied;
          },
        },
      },
    );

    const result = await createPurgeExecutor(deps)(command());
    expect(result).toMatchObject({
      success: false,
      failureCode: 'AWS_PERMISSION_DENIED',
    });
    expect(calls).toEqual([]);
  });

  it('classifies a permission failure while reading owned VPCs as retryable AWS_PERMISSION_DENIED', async () => {
    // CANARY-015: same rule as every other orphan read.
    const accessDenied = Object.assign(new Error('Access denied'), {
      name: 'AccessDenied',
      code: 'AccessDenied',
    });
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
      {
        network: {
          ...clients(calls).network,
          async listOwnedVpcs() {
            throw accessDenied;
          },
        },
      },
    );

    const result = await createPurgeExecutor(deps)(command());
    expect(result).toMatchObject({
      success: false,
      failureCode: 'AWS_PERMISSION_DENIED',
    });
    expect(calls).toEqual([]);
  });
});

describe('createPurgeResumer', () => {
  function pendingRecord(type: string) {
    return {
      commandId: 'cmd-1',
      idempotencyKey: 'key-1',
      type,
      stackName: APP_STACK,
      startedAt: '2026-08-31T00:00:00.000Z',
      payload: {},
    };
  }

  it('ignores pending debts that are not PURGE', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );
    await deps.pending.write(pendingRecord('DESTROY'));

    const results = await createPurgeResumer(deps)();
    expect(results).toEqual([]);
  });

  it('keeps the debt while the purge is still in flight', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack(stackName) {
          return stackName === APP_STACK ? appStack('DELETE_IN_PROGRESS') : { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );
    await deps.pending.write(pendingRecord('PURGE'));

    const results = await createPurgeResumer(deps)();
    expect(results).toEqual([]);
    expect(await deps.pending.read()).not.toBeNull();
  });

  it('settles a finished purge, clears the debt, and reports the result', async () => {
    const calls: string[] = [];
    const deps = depsWith(
      {
        async describeStack() {
          return { found: false };
        },
        async describeStackResources() {
          return [];
        },
      },
      calls,
    );
    await deps.pending.write(pendingRecord('PURGE'));

    const results = await createPurgeResumer(deps)();
    expect(results).toEqual([
      {
        commandId: 'cmd-1',
        idempotencyKey: 'key-1',
        success: true,
        output: { executed: true, type: 'PURGE', purged: true, connectorStackRetained: BOOTSTRAP_STACK },
      },
    ]);
    expect(await deps.pending.read()).toBeNull();
  });
});

// ── toNetworkPurgeClient (CANARY-015) ──────────────────────────────────────

describe('toNetworkPurgeClient', () => {
  const INSTALLATION = 'inst-net-7';

  it('filters DescribeVpcs by the installation tag and re-verifies the returned tags', async () => {
    const send = vi.fn().mockResolvedValue({
      Vpcs: [
        { VpcId: 'vpc-1', Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }] },
        // Refused even if somehow returned: the value does not match ours —
        // ownership is never inferred from presence alone.
        { VpcId: 'vpc-2', Tags: [{ Key: 'deployz:installation', Value: 'someone-else' }] },
        { VpcId: 'vpc-3', Tags: [] },
      ],
    });

    const owned = await toNetworkPurgeClient({ send }, INSTALLATION).listOwnedVpcs();

    expect(owned).toEqual(['vpc-1']);
    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      Filters: [{ Name: 'tag:deployz:installation', Values: [INSTALLATION] }],
    });
  });

  it('excludes the default security group even when it carries the installation tag', async () => {
    const send = vi.fn().mockResolvedValue({
      SecurityGroups: [
        {
          GroupId: 'sg-default',
          GroupName: 'default',
          Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }],
        },
        {
          GroupId: 'sg-app',
          GroupName: 'app-db',
          Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }],
        },
      ],
    });

    const owned = await toNetworkPurgeClient({ send }, INSTALLATION).listOwnedSecurityGroups('vpc-1');

    expect(owned).toEqual(['sg-app']);
  });

  it('refuses an untagged or foreign-tagged security group', async () => {
    const send = vi.fn().mockResolvedValue({
      SecurityGroups: [
        { GroupId: 'sg-untagged', GroupName: 'app-db', Tags: [] },
        {
          GroupId: 'sg-foreign',
          GroupName: 'app-db',
          Tags: [{ Key: 'deployz:installation', Value: 'someone-else' }],
        },
      ],
    });

    const owned = await toNetworkPurgeClient({ send }, INSTALLATION).listOwnedSecurityGroups('vpc-1');

    expect(owned).toEqual([]);
  });

  it('excludes the main route table even when it carries the installation tag', async () => {
    const send = vi.fn().mockResolvedValue({
      RouteTables: [
        {
          RouteTableId: 'rtb-main',
          Associations: [{ Main: true }],
          Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }],
        },
        {
          RouteTableId: 'rtb-custom',
          Associations: [{ Main: false }],
          Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }],
        },
      ],
    });

    const owned = await toNetworkPurgeClient({ send }, INSTALLATION).listOwnedRouteTables('vpc-1');

    expect(owned).toEqual(['rtb-custom']);
  });

  it('excludes a NAT gateway that is already deleting or deleted', async () => {
    const send = vi.fn().mockResolvedValue({
      NatGateways: [
        { NatGatewayId: 'nat-1', State: 'available', Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }] },
        { NatGatewayId: 'nat-2', State: 'deleting', Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }] },
        { NatGatewayId: 'nat-3', State: 'deleted', Tags: [{ Key: 'deployz:installation', Value: INSTALLATION }] },
      ],
    });

    const owned = await toNetworkPurgeClient({ send }, INSTALLATION).listOwnedNatGateways('vpc-1');

    expect(owned).toEqual(['nat-1']);
    // DescribeNatGateways uses `Filter` (singular) — the one exception among
    // every other Describe* action used here, which all take `Filters`.
    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toHaveProperty('Filter');
  });

  it('sends the delete/detach commands with exactly the ids passed', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = toNetworkPurgeClient({ send }, INSTALLATION);

    await client.deleteVpc('vpc-1');
    await client.deleteSubnet('subnet-1');
    await client.deleteSecurityGroup('sg-1');
    await client.detachInternetGateway('igw-1', 'vpc-1');
    await client.deleteInternetGateway('igw-1');
    await client.deleteNatGateway('nat-1');
    await client.deleteRouteTable('rtb-1');

    const inputs = send.mock.calls.map(
      (call) => (call[0] as { input: Record<string, unknown> }).input,
    );
    expect(inputs).toEqual([
      { VpcId: 'vpc-1' },
      { SubnetId: 'subnet-1' },
      { GroupId: 'sg-1' },
      { InternetGatewayId: 'igw-1', VpcId: 'vpc-1' },
      { InternetGatewayId: 'igw-1' },
      { NatGatewayId: 'nat-1' },
      { RouteTableId: 'rtb-1' },
    ]);
  });
});

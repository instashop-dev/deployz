import { describe, expect, it } from 'vitest';

import { logicalIdViolations, logicalResourceId, pascalCase } from './stable-identity.js';

// Golden tests: pin the exact logical ids the compiler derives, so a refactor
// that silently renames a resource (a CloudFormation replacement) fails CI.

describe('pascalCase', () => {
  it('capitalizes dash-separated tokens', () => {
    expect(pascalCase('primary-db', 'instance')).toBe('PrimaryDbInstance');
  });
  it('handles slashes and mixed separators', () => {
    expect(pascalCase('primary-db/rds-instance')).toBe('PrimaryDbRdsInstance');
  });
  it('is deterministic and collapses empty tokens', () => {
    expect(pascalCase('a--b', '')).toBe('AB');
  });
});

describe('logicalResourceId — stable semantic identity (golden)', () => {
  it('primary database instance', () => {
    expect(logicalResourceId('primary-db', 'instance')).toBe('PrimaryDbInstance');
  });
  it('primary database master secret', () => {
    expect(logicalResourceId('primary-db', 'master-secret')).toBe('PrimaryDbMasterSecret');
  });
  it('primary database url secret', () => {
    expect(logicalResourceId('primary-db', 'url-secret')).toBe('PrimaryDbUrlSecret');
  });
  it('network public subnet', () => {
    expect(logicalResourceId('network', 'public-subnet-1')).toBe('NetworkPublicSubnet1');
  });
  it('network vpc', () => {
    expect(logicalResourceId('network', 'vpc')).toBe('NetworkVpc');
  });
  it('web service', () => {
    expect(logicalResourceId('web', 'service')).toBe('WebService');
  });
  it('storage bucket', () => {
    expect(logicalResourceId('storage', 'bucket')).toBe('StorageBucket');
  });
  it('endpoint load balancer', () => {
    expect(logicalResourceId('endpoint', 'load-balancer')).toBe('EndpointLoadBalancer');
  });
  it('cache replication group', () => {
    expect(logicalResourceId('cache', 'replication-group')).toBe('CacheReplicationGroup');
  });
  it('worker workload services (Phase 4A golden ids)', () => {
    expect(logicalResourceId('email-worker', 'service')).toBe('EmailWorkerService');
    expect(logicalResourceId('email-worker', 'task-definition')).toBe('EmailWorkerTaskDefinition');
    expect(logicalResourceId('email-worker', 'log-group')).toBe('EmailWorkerLogGroup');
    expect(logicalResourceId('email-worker', 'service-security-group')).toBe('EmailWorkerServiceSecurityGroup');
    expect(logicalResourceId('import-worker', 'service')).toBe('ImportWorkerService');
    expect(logicalResourceId('primary-db', 'app-service-ingress-email-worker')).toBe(
      'PrimaryDbAppServiceIngressEmailWorker',
    );
  });
  it('one-shot migration workload (Phase 4C golden ids)', () => {
    expect(logicalResourceId('migration', 'task-definition')).toBe('MigrationTaskDefinition');
    expect(logicalResourceId('migration', 'log-group')).toBe('MigrationLogGroup');
  });
});

describe('logicalIdViolations', () => {
  it('accepts a unique, alphanumeric set', () => {
    expect(logicalIdViolations(['PrimaryDbInstance', 'WebService'])).toEqual([]);
  });
  it('rejects duplicates', () => {
    expect(logicalIdViolations(['WebService', 'WebService'])).toContain('duplicate logical id: WebService');
  });
  it('rejects non-alphanumeric and non-leading-letter ids', () => {
    expect(logicalIdViolations(['1WebService'])).toEqual(['invalid logical id: "1WebService"']);
    expect(logicalIdViolations(['Web-Service'])).toEqual(['invalid logical id: "Web-Service"']);
  });
});

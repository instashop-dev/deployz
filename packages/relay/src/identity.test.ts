import { afterEach, describe, expect, it } from 'vitest';

import {
  RELAY_CAPABILITIES,
  RELAY_VERSION,
  accountIdFromArn,
  readRelayIdentity,
} from './identity.js';

const ACCOUNT_ARN = 'arn:aws:lambda:us-east-1:151955775369:function:deployz-relay';

describe('accountIdFromArn', () => {
  it('extracts the account id from a Lambda ARN', () => {
    expect(accountIdFromArn(ACCOUNT_ARN)).toBe('151955775369');
  });

  it('returns null for a malformed ARN', () => {
    expect(accountIdFromArn('arn:aws:lambda:us-east-1:function')).toBeNull();
    expect(accountIdFromArn('')).toBeNull();
  });
});

describe('readRelayIdentity', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalBootstrap = process.env['DEPLOYZ_BOOTSTRAP_VERSION'];

  afterEach(() => {
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalBootstrap === undefined) delete process.env['DEPLOYZ_BOOTSTRAP_VERSION'];
    else process.env['DEPLOYZ_BOOTSTRAP_VERSION'] = originalBootstrap;
  });

  it('derives account and region from the Lambda context', () => {
    process.env['AWS_REGION'] = 'us-east-1';
    const identity = readRelayIdentity({ invokedFunctionArn: ACCOUNT_ARN });
    expect(identity.awsAccountId).toBe('151955775369');
    expect(identity.region).toBe('us-east-1');
    expect(identity.relayVersion).toBe(RELAY_VERSION);
    expect(identity.capabilities).toEqual(RELAY_CAPABILITIES);
  });

  it('omits account and region when context and env are absent', () => {
    delete process.env['AWS_REGION'];
    const identity = readRelayIdentity(undefined);
    expect(identity.awsAccountId).toBeUndefined();
    expect(identity.region).toBeUndefined();
    expect(identity.relayVersion).toBe(RELAY_VERSION);
  });

  it('reports the bootstrap version only when the env carries one', () => {
    delete process.env['DEPLOYZ_BOOTSTRAP_VERSION'];
    expect(readRelayIdentity(undefined).bootstrapVersion).toBeNull();
    process.env['DEPLOYZ_BOOTSTRAP_VERSION'] = '2026-08-28.1';
    expect(readRelayIdentity(undefined).bootstrapVersion).toBe('2026-08-28.1');
  });
});

describe('RELAY_CAPABILITIES', () => {
  it('advertises only what this build can actually execute', () => {
    expect(RELAY_CAPABILITIES.domainManagement).toBe(true);
    expect(RELAY_CAPABILITIES.deployRelease).toBe(true);
    expect(RELAY_CAPABILITIES.rollback).toBe(true);
    expect(RELAY_CAPABILITIES.restart).toBe(true);
    expect(RELAY_CAPABILITIES.configUpdate).toBe(true);
    expect(RELAY_CAPABILITIES.destroy).toBe(true);
  });
});

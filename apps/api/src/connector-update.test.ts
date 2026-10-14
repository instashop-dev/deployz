import { describe, expect, it } from 'vitest';

import { connectorUpdateOffer } from './connector-update.js';

const bound = { region: 'us-east-1', state: 'HEALTHY', relayBoundAt: new Date(), bootstrapStackName: 'deployz-acme-1' };
const config = { buildId: 'abc123def456', legacyUrl: undefined, deployableRegions: ['us-east-1', 'us-east-2'] };

describe('connectorUpdateOffer', () => {
  it('points at the existing stack and the immutable versioned template of the published build', () => {
    const offer = connectorUpdateOffer(bound, config)!;
    expect(offer.publishedBuildId).toBe('abc123def456');
    expect(offer.templateUrl).toBe(
      'https://deployz-templates-us-east-1.s3.us-east-1.amazonaws.com/bootstrap/v1/versions/abc123def456/bootstrap-template-v1.json',
    );
    expect(offer.updateUrl).toBe(
      'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringStatus=active&filteringText=deployz-acme-1',
    );
  });

  it('uses the regional bucket of the deployment', () => {
    expect(connectorUpdateOffer({ ...bound, region: 'us-east-2' }, config)!.templateUrl).toContain(
      'deployz-templates-us-east-2.s3.us-east-2.amazonaws.com/bootstrap/v1/versions/abc123def456/',
    );
  });

  it('falls back to the fixed latest template when the build id is unknown', () => {
    const offer = connectorUpdateOffer(bound, { ...config, buildId: undefined })!;
    expect(offer.publishedBuildId).toBeNull();
    expect(offer.templateUrl).toMatch(/bootstrap\/v1\/bootstrap-template-v1\.json$/);
  });

  it('offers nothing before enrollment or after removal, and no template for an unpublished region', () => {
    expect(connectorUpdateOffer({ ...bound, relayBoundAt: null }, config)).toBeNull();
    expect(connectorUpdateOffer({ ...bound, state: 'DELETED' }, config)).toBeNull();
    expect(connectorUpdateOffer({ ...bound, region: 'eu-west-1' }, config)!.templateUrl).toBeNull();
  });
});

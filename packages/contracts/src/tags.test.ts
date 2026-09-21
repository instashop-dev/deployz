import { describe, expect, it } from 'vitest';

import {
  buildDeploymentResourceTags,
  DEPLOYZ_COMPONENT_TAG,
  DEPLOYZ_ENVIRONMENT_TAG_VALUE,
  DEPLOYZ_INSTALLATION_TAG,
} from './tags.js';

describe('buildDeploymentResourceTags', () => {
  const IDENTITY = {
    deploymentId: 'dep-1',
    applicationId: 'app-1',
    customerId: 'cust-1',
    vendorId: 'org-1',
  };

  it('returns all seven tags when a release was selected', () => {
    expect(buildDeploymentResourceTags({ ...IDENTITY, releaseId: 'rel-1' })).toEqual({
      'deployz:managed-by': 'deployz',
      'deployz:deployment-id': 'dep-1',
      'deployz:application-id': 'app-1',
      'deployz:customer-id': 'cust-1',
      'deployz:vendor-id': 'org-1',
      'deployz:release-id': 'rel-1',
      'deployz:environment': 'production',
    });
  });

  it('omits the release-id tag when no release was selected', () => {
    const tags = buildDeploymentResourceTags(IDENTITY);
    expect(tags).toEqual({
      'deployz:managed-by': 'deployz',
      'deployz:deployment-id': 'dep-1',
      'deployz:application-id': 'app-1',
      'deployz:customer-id': 'cust-1',
      'deployz:vendor-id': 'org-1',
      'deployz:environment': 'production',
    });
  });

  it('environment is the constant production value — the MVP has no other environment', () => {
    expect(DEPLOYZ_ENVIRONMENT_TAG_VALUE).toBe('production');
    expect(buildDeploymentResourceTags(IDENTITY)['deployz:environment']).toBe(
      DEPLOYZ_ENVIRONMENT_TAG_VALUE,
    );
  });
});

describe('tag key constants', () => {
  it('installation tag key is stable — the relay IAM condition and verifier match on it', () => {
    expect(DEPLOYZ_INSTALLATION_TAG).toBe('deployz:installation');
  });

  it('component tag key is stable', () => {
    expect(DEPLOYZ_COMPONENT_TAG).toBe('deployz:component');
  });
});

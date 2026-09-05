import { describe, expect, it } from 'vitest';

import {
  DeploymentActionError,
  actionErrorMessage,
  listedUnderStatus,
  matchesRememberedCustomer,
  readinessFindingMessages,
  type RememberedCustomer,
} from '../src/lib/deployments';

describe('readinessFindingMessages', () => {
  it('lists the blocking findings a readiness rejection carries, in order', () => {
    expect(
      readinessFindingMessages({
        findings: [
          { id: 'required-env-vars-missing', severity: 'error', message: 'This app requires environment variables that have no value yet: FOO.' },
          { id: 'migration-command-missing', severity: 'warning', message: 'No migration command.' },
          { id: 'port-missing', severity: 'error', message: 'The application port is unknown.' },
        ],
      }),
    ).toEqual([
      'This app requires environment variables that have no value yet: FOO.',
      'The application port is unknown.',
    ]);
  });

  it('is empty for errors without findings', () => {
    expect(readinessFindingMessages(undefined)).toEqual([]);
    expect(readinessFindingMessages({ findings: 'nope' })).toEqual([]);
    expect(readinessFindingMessages([{ path: 'region', message: 'Required' }])).toEqual([]);
  });
});

const REMEMBERED: RememberedCustomer = {
  id: 'cust-1',
  name: 'Canary 20260902',
  email: 'canary@example.com',
};

describe('matchesRememberedCustomer', () => {
  it('returns false when nothing is remembered yet', () => {
    expect(matchesRememberedCustomer(null, REMEMBERED.name, REMEMBERED.email)).toBe(false);
  });

  it('reuses the remembered customer when the retry carries the same name and email', () => {
    expect(matchesRememberedCustomer(REMEMBERED, REMEMBERED.name, REMEMBERED.email)).toBe(true);
  });

  it('does not reuse the remembered customer when the name changed', () => {
    expect(matchesRememberedCustomer(REMEMBERED, 'Someone Else', REMEMBERED.email)).toBe(false);
  });

  it('does not reuse the remembered customer when the email changed', () => {
    expect(matchesRememberedCustomer(REMEMBERED, REMEMBERED.name, 'other@example.com')).toBe(
      false,
    );
  });
});

describe('actionErrorMessage', () => {
  it('explains a busy deployment', () => {
    expect(actionErrorMessage(new DeploymentActionError(409, 'DEPLOYMENT_BUSY'), 'fallback')).toBe(
      'Another operation is already running on this deployment. Wait for it to finish, then try again.',
    );
  });

  it('explains an unavailable release', () => {
    expect(
      actionErrorMessage(new DeploymentActionError(409, 'RELEASE_UNAVAILABLE'), 'fallback'),
    ).toBe(
      'This version can no longer be deployed because its build is no longer available. Create a new release to deploy it again.',
    );
  });

  it('falls back for any other error', () => {
    expect(actionErrorMessage(new DeploymentActionError(500, 'REQUEST_FAILED'), 'fallback')).toBe(
      'fallback',
    );
    expect(actionErrorMessage(new Error('nope'), 'fallback')).toBe('fallback');
  });
});

describe('listedUnderStatus', () => {
  it('keeps removed deployments out of the live fleet', () => {
    expect(listedUnderStatus({ state: 'DELETED' }, 'all')).toBe(false);
    expect(listedUnderStatus({ state: 'HEALTHY' }, 'all')).toBe(true);
  });

  it('lists removed deployments under the Removed filter only', () => {
    expect(listedUnderStatus({ state: 'DELETED' }, 'DELETED')).toBe(true);
    expect(listedUnderStatus({ state: 'HEALTHY' }, 'DELETED')).toBe(false);
    expect(listedUnderStatus({ state: 'HEALTHY' }, 'HEALTHY')).toBe(true);
  });
});

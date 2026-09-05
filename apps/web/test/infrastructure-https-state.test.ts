import { describe, expect, it } from 'vitest';

import type { InfrastructureHttpsState } from '../src/lib/deployments';
import {
  INFRASTRUCTURE_HTTPS_STATE_LABEL,
  INFRASTRUCTURE_STATUS_LABEL,
  infrastructureComponentStatusLabel,
} from '../src/lib/deployment-vocabulary';

describe('infrastructure HTTPS state vocabulary', () => {
  it('every https state has a non-empty label', () => {
    const states: InfrastructureHttpsState[] = [
      'SETTING_UP',
      'WAITING_FOR_CERTIFICATE',
      'ACTIVATING',
      'READY',
      'FAILED',
      'REMOVING',
    ];
    for (const state of states) {
      expect(INFRASTRUCTURE_HTTPS_STATE_LABEL[state]).toBeTruthy();
    }
  });

  it('prefers the https label when httpsState is set', () => {
    expect(
      infrastructureComponentStatusLabel({ status: 'provisioning', httpsState: 'WAITING_FOR_CERTIFICATE' }),
    ).toBe('Waiting for certificate');
  });

  it('falls back to the status label when httpsState is absent', () => {
    expect(infrastructureComponentStatusLabel({ status: 'ready' })).toBe(
      INFRASTRUCTURE_STATUS_LABEL.ready,
    );
    expect(infrastructureComponentStatusLabel({ status: 'ready' })).toBe('Ready');
  });
});

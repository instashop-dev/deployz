import { describe, expect, it } from 'vitest';

import {
  COMPATIBILITY_VERDICTS,
  CUSTOMER_DEPLOYMENT_STATUS_BADGE,
  CUSTOMER_DEPLOYMENT_STATUS_LABELS,
  CUSTOMER_DEPLOYMENT_STATUSES,
  DEPLOYMENT_STATE_BADGE,
  DEPLOYMENT_STATE_LABELS as COPY_MAP_DEPLOYMENT_STATE_LABELS,
  DEPLOYMENT_STATES,
  EXPLANATION_FALLBACK as COPY_MAP_EXPLANATION_FALLBACK,
  FAILURE_CODE_COPY as COPY_MAP_FAILURE_CODE_COPY,
  FAILURE_CODES as COPY_MAP_FAILURE_CODES,
  FAILURE_SEVERITY_BADGE as COPY_MAP_FAILURE_SEVERITY_BADGE,
  FAILURE_SEVERITY_DOT as COPY_MAP_FAILURE_SEVERITY_DOT,
  ONBOARDING_STEPS as COPY_MAP_ONBOARDING_STEPS,
  READINESS_STATES,
  READINESS_STATE_PRESENTATION as COPY_MAP_READINESS_STATE_PRESENTATION,
  SECRET_MASK,
  JARGON_PATTERN,
  deploymentStateLabel as copyMapDeploymentStateLabel,
  eventFamily as copyMapEventFamily,
  eventResultLabel as copyMapEventResultLabel,
  eventTypeLabel as copyMapEventTypeLabel,
  FAILURE_RECOVERABILITY as COPY_MAP_FAILURE_RECOVERABILITY,
  RECOVERABILITY_COPY as COPY_MAP_RECOVERABILITY_COPY,
  failureCodeCopy as copyMapFailureCodeCopy,
  readinessCountsLabel as copyMapReadinessCountsLabel,
  readinessStateFromVerdict as copyMapReadinessStateFromVerdict,
} from '@deployz/copy-map';

import {
  DEPLOYMENT_STATE_LABELS as WEB_DEPLOYMENT_STATE_LABELS,
  DEPLOYMENT_STATE_BADGE as WEB_DEPLOYMENT_STATE_BADGE,
  deploymentStateLabel as webDeploymentStateLabel,
  eventFamily as webEventFamily,
  eventResultLabel as webEventResultLabel,
  eventTypeLabel as webEventTypeLabel,
} from '../src/lib/deployment-vocabulary';

import {
  FAILURE_CODE_COPY as WEB_FAILURE_CODE_COPY,
  FAILURE_CODES as WEB_FAILURE_CODES,
  FAILURE_RECOVERABILITY as WEB_FAILURE_RECOVERABILITY,
  FAILURE_SEVERITY_BADGE as WEB_FAILURE_SEVERITY_BADGE,
  FAILURE_SEVERITY_DOT as WEB_FAILURE_SEVERITY_DOT,
  EXPLANATION_FALLBACK as WEB_EXPLANATION_FALLBACK,
  RECOVERABILITY_COPY as WEB_RECOVERABILITY_COPY,
  failureCodeCopy as webFailureCodeCopy,
} from '../src/lib/diagnostic-vocabulary';

import {
  ONBOARDING_STEPS as WEB_ONBOARDING_STEPS,
  READINESS_STATE_PRESENTATION as WEB_READINESS_STATE_PRESENTATION,
  readinessCountsLabel as webReadinessCountsLabel,
  readinessStateFromVerdict as webReadinessStateFromVerdict,
} from '../src/lib/readiness';

// Parity test: the web-side vocabulary modules must match the canonical
// copy-map package. When copy-map changes, this test fails and flags the
// web modules for an update. The web modules may stay as-is (re-exporting
// from copy-map is optional) — this test just ensures they don't drift.

describe('§46 deployment state vocabulary parity (web ↔ copy-map)', () => {
  it('state enums match', () => {
    expect([...DEPLOYMENT_STATES].sort()).toEqual(
      [...Object.keys(WEB_DEPLOYMENT_STATE_LABELS)].sort(),
    );
  });

  it('state labels match per state', () => {
    for (const state of DEPLOYMENT_STATES) {
      expect(
        WEB_DEPLOYMENT_STATE_LABELS[state],
        `label for ${state}`,
      ).toBe(COPY_MAP_DEPLOYMENT_STATE_LABELS[state]);
    }
  });

  it('state badge variants match per state', () => {
    for (const state of DEPLOYMENT_STATES) {
      expect(
        WEB_DEPLOYMENT_STATE_BADGE[state],
        `badge for ${state}`,
      ).toBe(DEPLOYMENT_STATE_BADGE[state]);
    }
  });

  it('deploymentStateLabel functions match for every state', () => {
    for (const state of DEPLOYMENT_STATES) {
      expect(webDeploymentStateLabel(state)).toBe(copyMapDeploymentStateLabel(state));
    }
  });
});

describe('§40 event family parity (web ↔ copy-map)', () => {
  const testTypes = [
    'deploy.state.updating',
    'rollback.restore',
    'config.write',
    'health.report',
    'install.state.healthy',
    'destroy.state.started',
    'billing.usage',
  ];

  it('eventFamily functions match', () => {
    for (const type of testTypes) {
      expect(webEventFamily(type), `family for ${type}`).toBe(copyMapEventFamily(type));
    }
  });

  it('eventTypeLabel functions match for known types', () => {
    const knownTypes = [
      'deploy.state.updating',
      'rollback.restore',
      'install.state.healthy',
      'deploy.state.update-available',
      'operation.timeout',
      'operation.waiting_for_relay',
      'operation.requeued',
    ];
    for (const type of knownTypes) {
      expect(webEventTypeLabel(type), `label for ${type}`).toBe(copyMapEventTypeLabel(type));
    }
  });

  it('eventTypeLabel functions match for fallback types', () => {
    expect(webEventTypeLabel('health.report')).toBe(copyMapEventTypeLabel('health.report'));
    expect(webEventTypeLabel('destroy.state.started')).toBe(
      copyMapEventTypeLabel('destroy.state.started'),
    );
  });
});

describe('§62 event result label parity (web ↔ copy-map)', () => {
  it('eventResultLabel functions match', () => {
    expect(webEventResultLabel('ok')).toBe(copyMapEventResultLabel('ok'));
    expect(webEventResultLabel('passed')).toBe(copyMapEventResultLabel('passed'));
    expect(webEventResultLabel('skipped')).toBe(copyMapEventResultLabel('skipped'));
    expect(webEventResultLabel('failed:MIGRATION_FAILED')).toBe(
      copyMapEventResultLabel('failed:MIGRATION_FAILED'),
    );
    expect(webEventResultLabel(null)).toBe(copyMapEventResultLabel(null));
  });
});

describe('§61 failure code vocabulary parity (web ↔ copy-map)', () => {
  it('failure code enums match', () => {
    expect([...COPY_MAP_FAILURE_CODES].sort()).toEqual([...WEB_FAILURE_CODES].sort());
  });

  it('failure code copy matches per code', () => {
    for (const code of COPY_MAP_FAILURE_CODES) {
      const copyMapCopy = COPY_MAP_FAILURE_CODE_COPY[code];
      const webCopy = WEB_FAILURE_CODE_COPY[code];
      expect(webCopy.label, `label for ${code}`).toBe(copyMapCopy.label);
      expect(webCopy.description, `description for ${code}`).toBe(copyMapCopy.description);
      expect(webCopy.severity, `severity for ${code}`).toBe(copyMapCopy.severity);
    }
  });

  it('failure recoverability mappings and copy match', () => {
    expect(WEB_FAILURE_RECOVERABILITY).toEqual(COPY_MAP_FAILURE_RECOVERABILITY);
    expect(WEB_RECOVERABILITY_COPY).toEqual(COPY_MAP_RECOVERABILITY_COPY);
  });

  it('failure severity badge mappings match', () => {
    expect(WEB_FAILURE_SEVERITY_BADGE).toEqual(COPY_MAP_FAILURE_SEVERITY_BADGE);
  });

  it('failure severity dot mappings match', () => {
    expect(WEB_FAILURE_SEVERITY_DOT).toEqual(COPY_MAP_FAILURE_SEVERITY_DOT);
  });

  it('explanation fallback copy matches', () => {
    expect(WEB_EXPLANATION_FALLBACK).toEqual(COPY_MAP_EXPLANATION_FALLBACK);
  });

  it('failureCodeCopy functions match for every code', () => {
    for (const code of COPY_MAP_FAILURE_CODES) {
      const copyMapResult = copyMapFailureCodeCopy(code);
      const webResult = webFailureCodeCopy(code);
      expect(webResult.label).toBe(copyMapResult.label);
    }
  });

  it('failureCodeCopy fallback matches for unknown codes', () => {
    expect(webFailureCodeCopy('UNLISTED').label).toBe(
      copyMapFailureCodeCopy('UNLISTED').label,
    );
  });
});

describe('§19 readiness state parity (web ↔ copy-map)', () => {
  it('state presentations match per state', () => {
    for (const state of READINESS_STATES) {
      const copyMapPres = COPY_MAP_READINESS_STATE_PRESENTATION[state];
      const webPres = WEB_READINESS_STATE_PRESENTATION[state];
      expect(webPres.heading, `heading for ${state}`).toBe(copyMapPres.heading);
      expect(webPres.label, `label for ${state}`).toBe(copyMapPres.label);
      expect(webPres.tone, `tone for ${state}`).toBe(copyMapPres.tone);
    }
  });

  it('readinessStateFromVerdict functions match for every §19 verdict', () => {
    for (const verdict of COMPATIBILITY_VERDICTS) {
      expect(webReadinessStateFromVerdict(verdict)).toBe(copyMapReadinessStateFromVerdict(verdict));
    }
  });

  it('readinessCountsLabel functions match for a spot-check of (required, recommended) pairs', () => {
    const pairs: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [2, 1],
      [1, 1],
      [3, 5],
    ];
    for (const [required, recommended] of pairs) {
      expect(
        webReadinessCountsLabel(required, recommended),
        `counts label for (${required}, ${recommended})`,
      ).toBe(copyMapReadinessCountsLabel(required, recommended));
    }
  });
});

describe('§42 onboarding step parity (web ↔ copy-map)', () => {
  it('onboarding steps match', () => {
    expect(WEB_ONBOARDING_STEPS).toEqual(COPY_MAP_ONBOARDING_STEPS);
  });
});

describe('§31 secret mask parity', () => {
  it('SECRET_MASK is the canonical value', () => {
    expect(SECRET_MASK).toBe('***');
  });
});

describe('§65 jargon-free parity', () => {
  it('all web-side labels are jargon-free against the copy-map JARGON_PATTERN', () => {
    for (const state of DEPLOYMENT_STATES) {
      expect(WEB_DEPLOYMENT_STATE_LABELS[state]).not.toMatch(JARGON_PATTERN);
    }
    for (const code of COPY_MAP_FAILURE_CODES) {
      expect(WEB_FAILURE_CODE_COPY[code].label).not.toMatch(JARGON_PATTERN);
      expect(WEB_FAILURE_CODE_COPY[code].description).not.toMatch(JARGON_PATTERN);
    }
    for (const state of READINESS_STATES) {
      expect(WEB_READINESS_STATE_PRESENTATION[state].heading).not.toMatch(JARGON_PATTERN);
      expect(WEB_READINESS_STATE_PRESENTATION[state].label).not.toMatch(JARGON_PATTERN);
    }
  });
});

describe('customer deployment rollup vocabulary parity (§65 jargon-free)', () => {
  it('every rollup status has a jargon-free label and a badge variant', () => {
    for (const status of CUSTOMER_DEPLOYMENT_STATUSES) {
      expect(CUSTOMER_DEPLOYMENT_STATUS_LABELS[status], `label for ${status}`).not.toMatch(
        JARGON_PATTERN,
      );
      expect(CUSTOMER_DEPLOYMENT_STATUS_BADGE[status], `badge for ${status}`).toBeDefined();
    }
  });
});

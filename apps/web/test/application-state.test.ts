import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_POLL_MS,
  APPLICATION_STATES,
  STALE_NOTICE,
  TEST_DEPLOYMENT_POLL_MS,
  customerDeployments,
  deriveApplicationPresentation,
  latestTestDeployment,
  testDeploymentPhase,
  type ApplicationState,
  type ApplicationStateInput,
  type InstallLinkPlacement,
  type SetupLifecycleItem,
  type SetupLifecycleStepState,
} from '../src/lib/application-state';
import { deploymentDisplayStatus } from '../src/lib/deployment-status-groups';
import type { FleetDeployment } from '../src/lib/deployments';
import type { PublicInstallLinkStatus, PublicInstallLinkView } from '../src/lib/public-install-links';
import type { ApplicationReadiness, ReadinessFinding } from '../src/lib/readiness';
import { fleetDeployment } from './fixtures/fleet-deployment';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function readiness(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'READY',
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [{ id: 'docker', label: 'Docker container detected' }],
    analyzedCommitSha: 'abc1234',
    detected: null,
    requirements: null,
    deploymentRequirementDrift: [],
    ...overrides,
  };
}

function requiredFinding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'health-endpoint',
    category: 'health',
    title: 'Health endpoint missing',
    severity: 'required',
    blocking: true,
    plainEnglishExplanation: 'Deployz requires an HTTP health endpoint.',
    whyItMatters: 'Without it, Deployz cannot tell if your app is running.',
    technicalEvidence: 'No route responded on /health.',
    suggestedOutcome: 'Add a GET /health route that returns HTTP 200.',
    confidence: 'confirmed',
    ...overrides,
  };
}

function recommendedFinding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'logging',
    category: 'observability',
    title: 'Structured logging recommended',
    severity: 'recommended',
    blocking: false,
    plainEnglishExplanation: 'Logs are not structured as JSON.',
    whyItMatters: 'Structured logs are easier to search.',
    technicalEvidence: 'Log lines are plain text.',
    suggestedOutcome: 'Emit logs as JSON.',
    confidence: 'likely',
    ...overrides,
  };
}

/** A TEST deployment (the vendor's own trial install). */
function deployment(overrides: Partial<FleetDeployment> = {}): FleetDeployment {
  return fleetDeployment({ deploymentType: 'TEST', state: 'NOT_INSTALLED', ...overrides });
}

/** A customer (PRODUCTION) deployment. */
function customer(overrides: Partial<FleetDeployment> = {}): FleetDeployment {
  return fleetDeployment({ deploymentType: 'PRODUCTION', state: 'HEALTHY', ...overrides });
}

function link(overrides: Partial<PublicInstallLinkView> = {}): PublicInstallLinkView {
  return {
    id: 'link-1',
    url: 'https://deployz.dev/i/abc123',
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

function makeInput(
  opts: {
    readiness?: Partial<ApplicationReadiness>;
    deployments?: FleetDeployment[];
    installLinks?: ApplicationStateInput['installLinks'];
    stale?: boolean;
    analysisTakingLonger?: boolean;
    applicationId?: string;
    applicationName?: string;
  } = {},
): ApplicationStateInput {
  return {
    data: {
      application: { id: opts.applicationId ?? 'app-1', name: opts.applicationName ?? 'My App' },
      readiness: readiness(opts.readiness),
      deployments: opts.deployments ?? [],
    },
    installLinks: opts.installLinks !== undefined ? opts.installLinks : [],
    stale: opts.stale ?? false,
    analysisTakingLonger: opts.analysisTakingLonger ?? false,
  };
}

function lifecycleSteps(
  analyse: SetupLifecycleStepState,
  configure: SetupLifecycleStepState,
  test: SetupLifecycleStepState,
  share: SetupLifecycleStepState = 'pending',
): SetupLifecycleItem[] {
  return [
    { step: 'Analyse', state: analyse },
    { step: 'Configure', state: configure },
    { step: 'Test', state: test },
    { step: 'Share', state: share },
  ];
}

/** No output field may leak a raw enum value the UI does not know how to word. */
function assertNoRawLeak(result: ReturnType<typeof deriveApplicationPresentation>, raw: string) {
  const haystack = [
    result.heading,
    result.message,
    result.badge.label,
    result.readinessSummary ?? '',
    ...result.notices.map((n) => n.text),
    result.recentEvent?.status ?? '',
  ].join(' ');
  expect(haystack).not.toContain(raw);
}

const CHECK_PASSED_PATTERN = /checks? passed/i;

// ── 1. Canonical state matrix ────────────────────────────────────────────────

interface StateCase {
  input: ApplicationStateInput;
  badgeLabel: string;
  heading: string;
  primaryActionId: string | null;
  polling: number | null;
  busy: boolean;
  lifecycle: SetupLifecycleItem[] | null;
  installLinkAvailable: boolean;
  installLinkPlacement: InstallLinkPlacement;
}

const STATE_CASES: Record<ApplicationState, StateCase> = {
  unavailable: {
    input: { data: null, installLinks: [], stale: false, analysisTakingLonger: false },
    badgeLabel: 'Unavailable',
    heading: 'This application is temporarily unavailable',
    primaryActionId: 'retry-load',
    polling: null,
    busy: false,
    lifecycle: null,
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  analysing: {
    input: makeInput({ readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' } }),
    badgeLabel: 'Analysing',
    heading: 'Analysing your application',
    primaryActionId: null,
    polling: ANALYSIS_POLL_MS,
    busy: true,
    lifecycle: lifecycleSteps('current', 'pending', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'card',
  },
  'analysis-failed': {
    input: makeInput({
      readiness: { analysisStatus: 'FAILED', state: 'ANALYSIS_INCOMPLETE', failureReason: 'Boom' },
    }),
    badgeLabel: 'Analysis failed',
    heading: "We couldn't analyse your application",
    primaryActionId: 'retry-analysis',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('failed', 'pending', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'card',
  },
  'configuration-required': {
    input: makeInput({
      readiness: { state: 'NEEDS_CHANGES', findings: [requiredFinding()], requiredCount: 1 },
    }),
    badgeLabel: 'Changes required',
    heading: '1 change required',
    primaryActionId: 'review-configuration',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('done', 'current', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'card',
  },
  'ready-to-test': {
    input: makeInput(),
    badgeLabel: 'Ready to test',
    heading: 'Ready for a test deployment',
    primaryActionId: 'start-test',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('done', 'done', 'current'),
    installLinkAvailable: false,
    installLinkPlacement: 'card',
  },
  'test-queued': {
    input: makeInput({ deployments: [deployment({ state: 'NOT_INSTALLED' })] }),
    badgeLabel: 'Test not started',
    heading: 'Your test deployment has not started',
    primaryActionId: 'continue-test',
    polling: TEST_DEPLOYMENT_POLL_MS,
    busy: false,
    lifecycle: lifecycleSteps('done', 'done', 'current'),
    installLinkAvailable: false,
    installLinkPlacement: 'card',
  },
  'test-deploying': {
    input: makeInput({ deployments: [deployment({ state: 'INSTALLING' })] }),
    badgeLabel: 'Test deploying',
    heading: 'Test deployment in progress',
    primaryActionId: 'view-progress',
    polling: TEST_DEPLOYMENT_POLL_MS,
    busy: true,
    lifecycle: lifecycleSteps('done', 'done', 'current'),
    installLinkAvailable: false,
    installLinkPlacement: 'card',
  },
  'test-removing': {
    input: makeInput({ deployments: [deployment({ state: 'DELETING' })] }),
    badgeLabel: 'Removing test',
    heading: 'Removing the test deployment',
    primaryActionId: 'view-progress',
    polling: TEST_DEPLOYMENT_POLL_MS,
    busy: true,
    lifecycle: lifecycleSteps('done', 'done', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'card',
  },
  'test-failed': {
    input: makeInput({ deployments: [deployment({ state: 'FAILED' })] }),
    badgeLabel: 'Test failed',
    heading: 'Test deployment failed',
    primaryActionId: 'review-failure',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('done', 'done', 'failed'),
    installLinkAvailable: false,
    installLinkPlacement: 'card',
  },
  'ready-to-share': {
    input: makeInput({ deployments: [deployment({ state: 'HEALTHY' })] }),
    badgeLabel: 'Ready to share',
    heading: 'Ready to share with customers',
    primaryActionId: 'create-install-link',
    polling: null,
    busy: false,
    lifecycle: null,
    installLinkAvailable: true,
    installLinkPlacement: 'primary',
  },
  'customers-active': {
    input: makeInput({ deployments: [customer({ state: 'HEALTHY' })] }),
    badgeLabel: 'Live with customers',
    heading: '1 customer deployment',
    primaryActionId: 'view-customer-deployments',
    polling: null,
    busy: false,
    lifecycle: null,
    installLinkAvailable: true,
    installLinkPlacement: 'card',
  },
  unknown: {
    input: makeInput({
      readiness: { analysisStatus: 'QUEUED' as ApplicationReadiness['analysisStatus'] },
    }),
    badgeLabel: 'Status unknown',
    heading: "We can't show this application's status",
    primaryActionId: 'analyse',
    polling: null,
    busy: false,
    lifecycle: null,
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
};

describe('canonical state matrix', () => {
  it('has exactly one fixture per state in APPLICATION_STATES', () => {
    expect(Object.keys(STATE_CASES).sort()).toEqual([...APPLICATION_STATES].sort());
  });

  it.each(APPLICATION_STATES.map((state) => [state, STATE_CASES[state]] as const))(
    '%s renders the documented presentation',
    (state, expected) => {
      const result = deriveApplicationPresentation(expected.input);
      expect(result.state).toBe(state);
      expect(result.badge.label).toBe(expected.badgeLabel);
      expect(result.heading).toBe(expected.heading);
      expect(result.primaryAction?.id ?? null).toBe(expected.primaryActionId);
      expect(result.polling).toEqual(expected.polling === null ? null : { intervalMs: expected.polling });
      expect(result.busy).toBe(expected.busy);
      expect(result.lifecycle).toEqual(expected.lifecycle);
      expect(result.installLinkAvailable).toBe(expected.installLinkAvailable);
      expect(result.installLinkPlacement).toBe(expected.installLinkPlacement);
    },
  );
});

// ── 2. Unknown / legacy inputs ───────────────────────────────────────────────

describe('unknown and legacy inputs', () => {
  it('an unknown analysisStatus never throws and never leaks the raw value', () => {
    const input = makeInput({ readiness: { analysisStatus: 'QUEUED' as ApplicationReadiness['analysisStatus'] } });
    let result!: ReturnType<typeof deriveApplicationPresentation>;
    expect(() => {
      result = deriveApplicationPresentation(input);
    }).not.toThrow();
    expect(result.state).toBe('unknown');
    assertNoRawLeak(result, 'QUEUED');
  });

  it('an unknown deployment state never throws and never leaks the raw value', () => {
    const input = makeInput({ deployments: [deployment({ state: 'MIGRATING' as FleetDeployment['state'] })] });
    let result!: ReturnType<typeof deriveApplicationPresentation>;
    expect(() => {
      result = deriveApplicationPresentation(input);
    }).not.toThrow();
    expect(result.state).toBe('unknown');
    assertNoRawLeak(result, 'MIGRATING');
  });

  it('an install link with an unknown status never throws and never leaks the raw value', () => {
    const weirdLink = link({ status: 'pending_review' as PublicInstallLinkStatus });
    const input = makeInput({ deployments: [deployment({ state: 'HEALTHY' })], installLinks: [weirdLink] });
    let result!: ReturnType<typeof deriveApplicationPresentation>;
    expect(() => {
      result = deriveApplicationPresentation(input);
    }).not.toThrow();
    expect(result.installLink).toMatchObject({ kind: 'live', status: 'unknown' });
    assertNoRawLeak(result, 'pending_review');
  });

  it('observedState: null never throws and hides the open-application action', () => {
    const input = makeInput({ deployments: [deployment({ state: 'HEALTHY', observedState: null })] });
    const result = deriveApplicationPresentation(input);
    expect(result.secondaryActions.some((a) => a.id === 'open-application')).toBe(false);
  });

  it('a missing requirements field never throws', () => {
    const broken = { ...readiness(), requirements: undefined } as unknown as ApplicationReadiness;
    const input: ApplicationStateInput = {
      data: { application: { id: 'app-1', name: 'My App' }, readiness: broken, deployments: [] },
      installLinks: [],
      stale: false,
      analysisTakingLonger: false,
    };
    expect(() => deriveApplicationPresentation(input)).not.toThrow();
  });
});

// ── 3. Conflicting / stale raw states ────────────────────────────────────────

describe('conflicting or stale raw states resolve to exactly one story', () => {
  it('READY readiness + NOT_INSTALLED test + an active install link → test-queued, link flagged, not "ready"', () => {
    const activeLink = link({ status: 'active' });
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'READY', requiredCount: 0, findings: [] },
        deployments: [deployment({ state: 'NOT_INSTALLED' })],
        installLinks: [activeLink],
      }),
    );
    expect(result.state).toBe('test-queued');
    expect(result.heading).not.toMatch(/ready/i);
    expect(result.installLinkAvailable).toBe(false);
    expect(result.installLink).toMatchObject({ kind: 'live', status: 'active' });
    expect((result.installLink as { warning: string | null }).warning).not.toBeNull();
    const haystack = [result.heading, result.message, result.readinessSummary ?? '', ...result.notices.map((n) => n.text)].join(
      ' ',
    );
    expect(haystack).not.toMatch(CHECK_PASSED_PATTERN);
  });

  it('READY readiness + INSTALLING test → test-deploying (an active operation beats readiness)', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'READY', requiredCount: 0, findings: [] },
        deployments: [deployment({ state: 'INSTALLING' })],
      }),
    );
    expect(result.state).toBe('test-deploying');
  });

  it('ANALYZING + a verified test deployment → analysing (the running analysis wins)', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' },
        deployments: [deployment({ state: 'HEALTHY' })],
      }),
    );
    expect(result.state).toBe('analysing');
  });

  it('required changes + a verified test + customers → configuration-required, lifecycle null', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'NEEDS_CHANGES', findings: [requiredFinding()], requiredCount: 1 },
        deployments: [deployment({ state: 'HEALTHY' }), customer({ state: 'HEALTHY' })],
      }),
    );
    expect(result.state).toBe('configuration-required');
    expect(result.lifecycle).toBeNull();
  });

  it('FAILED analysis + INSTALLING test → test-deploying (the active operation beats the failed analysis)', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { analysisStatus: 'FAILED', state: 'ANALYSIS_INCOMPLETE', failureReason: 'x' },
        deployments: [deployment({ state: 'INSTALLING' })],
      }),
    );
    expect(result.state).toBe('test-deploying');
  });
});

// ── 4. Active → terminal transitions ─────────────────────────────────────────

describe('test deployment: active states poll and are busy as documented, terminal states are not', () => {
  it.each([
    ['NOT_INSTALLED', TEST_DEPLOYMENT_POLL_MS, false],
    ['WAITING_FOR_RELAY', TEST_DEPLOYMENT_POLL_MS, true],
    ['INSTALLING', TEST_DEPLOYMENT_POLL_MS, true],
    ['DELETING', TEST_DEPLOYMENT_POLL_MS, true],
  ] as const)('%s is active: polling and busy', (state, polling, busy) => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state })] }));
    expect(result.polling).toEqual({ intervalMs: polling });
    expect(result.busy).toBe(busy);
  });

  it.each(['HEALTHY', 'FAILED'] as const)('%s is terminal: no polling, not busy', (state) => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state })] }));
    expect(result.polling).toBeNull();
    expect(result.busy).toBe(false);
  });

  it('DELETED is treated as no test deployment at all (terminal ready-to-test)', () => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state: 'DELETED' })] }));
    expect(result.state).toBe('ready-to-test');
    expect(result.polling).toBeNull();
    expect(result.busy).toBe(false);
  });
});

describe('analysis: PENDING/ANALYZING poll, COMPLETE/FAILED do not', () => {
  it.each([
    ['PENDING', false],
    ['ANALYZING', true],
  ] as const)('%s is active', (status, busy) => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: status, state: 'ANALYSIS_INCOMPLETE' } }),
    );
    expect(result.polling).toEqual({ intervalMs: ANALYSIS_POLL_MS });
    expect(result.busy).toBe(busy);
  });

  it('COMPLETE is terminal', () => {
    const result = deriveApplicationPresentation(makeInput());
    expect(result.polling).toBeNull();
    expect(result.busy).toBe(false);
  });

  it('FAILED is terminal', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'FAILED', state: 'ANALYSIS_INCOMPLETE', failureReason: 'x' } }),
    );
    expect(result.polling).toBeNull();
    expect(result.busy).toBe(false);
  });

  it('analysisTakingLonger swaps the primary action to restart-analysis only while ANALYZING', () => {
    const pendingStuck = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'PENDING', state: 'ANALYSIS_INCOMPLETE' }, analysisTakingLonger: true }),
    );
    expect(pendingStuck.primaryAction?.id).toBe('analyse');

    const analyzingNotStuck = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' }, analysisTakingLonger: false }),
    );
    expect(analyzingNotStuck.primaryAction).toBeNull();

    const analyzingStuck = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' }, analysisTakingLonger: true }),
    );
    expect(analyzingStuck.primaryAction?.id).toBe('restart-analysis');
  });
});

// ── 5. Readiness summary, blockers, recommendations ──────────────────────────

describe('readiness summary, blockers and recommendations', () => {
  it.each([
    [1, '1 change required'],
    [3, '3 changes required'],
  ])('summarises %d required finding(s) as "%s"', (count, expected) => {
    const findings = Array.from({ length: count }, (_, i) => requiredFinding({ id: `f-${i}`, title: `Fix ${i}` }));
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { state: 'NEEDS_CHANGES', findings, requiredCount: count } }),
    );
    expect(result.state).toBe('configuration-required');
    expect(result.readinessSummary).toBe(expected);
    expect(result.blockers).toEqual(findings.map((f) => ({ id: f.id, title: f.title })));
  });

  it('reads "Ready to test" in ready-to-test', () => {
    const result = deriveApplicationPresentation(makeInput());
    expect(result.state).toBe('ready-to-test');
    expect(result.readinessSummary).toBe('Ready to test');
  });

  it('reads "No blocking issues" after analysis once there is no blocking finding and the card is not ready-to-test', () => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state: 'NOT_INSTALLED' })] }));
    expect(result.state).toBe('test-queued');
    expect(result.readinessSummary).toBe('No blocking issues');
  });

  it('is null before a completed analysis', () => {
    for (const status of ['PENDING', 'ANALYZING', 'FAILED'] as const) {
      const result = deriveApplicationPresentation(
        makeInput({
          readiness: { analysisStatus: status, state: 'ANALYSIS_INCOMPLETE', failureReason: status === 'FAILED' ? 'x' : null },
        }),
      );
      expect(result.readinessSummary, status).toBeNull();
    }
  });

  it('blockers are populated only in configuration-required, even when an active test op takes precedence', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'NEEDS_CHANGES', findings: [requiredFinding()], requiredCount: 1 },
        deployments: [deployment({ state: 'NOT_INSTALLED' })],
      }),
    );
    expect(result.state).toBe('test-queued');
    expect(result.blockers).toEqual([]);
    // The readiness truth still shows through even though the card tells the test-deployment story.
    expect(result.readinessSummary).toBe('1 change required');
  });

  it('recommendationCount counts recommended findings regardless of state', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { findings: [recommendedFinding(), recommendedFinding({ id: 'r2' })] } }),
    );
    expect(result.recommendationCount).toBe(2);
  });

  it('never renders a passed-check count anywhere, across the whole state matrix', () => {
    for (const [state, testCase] of Object.entries(STATE_CASES)) {
      const result = deriveApplicationPresentation(testCase.input);
      const haystack = [
        result.heading,
        result.message,
        result.badge.label,
        result.readinessSummary ?? '',
        ...result.notices.map((n) => n.text),
      ].join(' ');
      expect(haystack, state).not.toMatch(CHECK_PASSED_PATTERN);
    }
  });
});

// ── 6. Install link derivation ───────────────────────────────────────────────

describe('install link derivation', () => {
  const readyToShareInput = (installLinks: ApplicationStateInput['installLinks']) =>
    makeInput({ deployments: [deployment({ state: 'HEALTHY' })], installLinks });

  it('ready-to-share, no links → create with no note, primary create-install-link', () => {
    const result = deriveApplicationPresentation(readyToShareInput([]));
    expect(result.installLink).toEqual({ kind: 'create', note: null });
    expect(result.primaryAction?.id).toBe('create-install-link');
  });

  it('ready-to-share, only revoked links → create with a note', () => {
    const result = deriveApplicationPresentation(readyToShareInput([link({ status: 'revoked' })]));
    expect(result.installLink).toEqual({
      kind: 'create',
      note: 'The previous link was revoked. Create a new link to share the application.',
    });
  });

  it('ready-to-share, an active link → live/active, copy action, preview secondary', () => {
    const activeLink = link({ status: 'active' });
    const result = deriveApplicationPresentation(readyToShareInput([activeLink]));
    expect(result.installLink).toEqual({ kind: 'live', link: activeLink, status: 'active', warning: null });
    expect(result.primaryAction?.id).toBe('copy-install-link');
    expect(result.secondaryActions[0]).toMatchObject({
      id: 'preview-install-link',
      external: true,
      href: activeLink.url,
    });
  });

  it('ready-to-share, a disabled link → live/disabled, no warning', () => {
    const result = deriveApplicationPresentation(readyToShareInput([link({ status: 'disabled' })]));
    expect(result.installLink).toMatchObject({ kind: 'live', status: 'disabled', warning: null });
  });

  it('installLinks: null → loading', () => {
    const result = deriveApplicationPresentation(readyToShareInput(null));
    expect(result.installLink).toEqual({ kind: 'loading' });
  });

  it("installLinks: 'error' → error", () => {
    const result = deriveApplicationPresentation(readyToShareInput('error'));
    expect(result.installLink).toEqual({
      kind: 'error',
      message: "We couldn't load the customer install link. Try again in a moment.",
    });
  });

  it('not ready + no link → unavailable with a non-empty reason', () => {
    const result = deriveApplicationPresentation(makeInput({ installLinks: [] }));
    expect(result.state).toBe('ready-to-test');
    expect(result.installLink).toMatchObject({ kind: 'unavailable' });
    expect((result.installLink as { reason: string }).reason).toBeTruthy();
  });

  it('not ready + a disabled link → live with no warning', () => {
    const result = deriveApplicationPresentation(makeInput({ installLinks: [link({ status: 'disabled' })] }));
    expect(result.state).toBe('ready-to-test');
    expect(result.installLink).toMatchObject({ kind: 'live', status: 'disabled', warning: null });
  });

  it('the unavailable application state hides the install link entirely, placement none', () => {
    const result = deriveApplicationPresentation({
      data: null,
      installLinks: [link()],
      stale: false,
      analysisTakingLonger: false,
    });
    expect(result.installLink).toEqual({ kind: 'hidden' });
    expect(result.installLinkPlacement).toBe('none');
  });

  it('the unknown state also hides the install link, ignoring whatever links exist', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'QUEUED' as ApplicationReadiness['analysisStatus'] }, installLinks: [link()] }),
    );
    expect(result.state).toBe('unknown');
    expect(result.installLink).toEqual({ kind: 'hidden' });
    expect(result.installLinkPlacement).toBe('none');
  });

  it('customers-active places the install link as its own card, not primary', () => {
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [customer({ state: 'HEALTHY' })], installLinks: [link({ status: 'active' })] }),
    );
    expect(result.installLinkAvailable).toBe(true);
    expect(result.installLinkPlacement).toBe('card');
  });
});

// ── 7. Lifecycle ──────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('shows 4 steps, Analyse/Configure/Test/Share, in order during initial setup', () => {
    const result = deriveApplicationPresentation(makeInput());
    expect(result.lifecycle?.map((s) => s.step)).toEqual(['Analyse', 'Configure', 'Test', 'Share']);
    expect(result.lifecycle).toHaveLength(4);
  });

  it('is null once a verified test deployment exists', () => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state: 'HEALTHY' })] }));
    expect(result.lifecycle).toBeNull();
  });

  it('is null once any customer deployment exists', () => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [customer({ state: 'HEALTHY' })] }));
    expect(result.lifecycle).toBeNull();
  });

  it('stays null while re-analysing after setup is already complete', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' },
        deployments: [deployment({ state: 'HEALTHY' })],
      }),
    );
    expect(result.state).toBe('analysing');
    expect(result.lifecycle).toBeNull();
  });
});

// ── 8. recentEvent + stale ────────────────────────────────────────────────────

describe('recentEvent', () => {
  it('is present for analysing, when a test deployment exists but the card tells the analysis story instead', () => {
    const test = deployment({ state: 'HEALTHY' });
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' }, deployments: [test] }),
    );
    expect(result.state).toBe('analysing');
    expect(result.recentEvent).toEqual({
      label: 'Test deployment',
      status: deploymentDisplayStatus(test).label,
      at: test.updatedAt,
      href: `/dashboard/deployments/${test.id}`,
    });
  });

  it('is present for analysis-failed', () => {
    const test = deployment({ state: 'HEALTHY' });
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { analysisStatus: 'FAILED', state: 'ANALYSIS_INCOMPLETE', failureReason: 'x' },
        deployments: [test],
      }),
    );
    expect(result.state).toBe('analysis-failed');
    expect(result.recentEvent).not.toBeNull();
  });

  it('is present for configuration-required', () => {
    const test = deployment({ state: 'HEALTHY' });
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'NEEDS_CHANGES', findings: [requiredFinding()], requiredCount: 1 },
        deployments: [test],
      }),
    );
    expect(result.state).toBe('configuration-required');
    expect(result.recentEvent).not.toBeNull();
  });

  it('is present for customers-active, and a FAILED test also raises an attention notice', () => {
    const test = deployment({ state: 'FAILED' });
    const result = deriveApplicationPresentation(makeInput({ deployments: [test, customer({ state: 'HEALTHY' })] }));
    expect(result.state).toBe('customers-active');
    expect(result.recentEvent).not.toBeNull();
    expect(result.notices).toContainEqual({ tone: 'warning', text: 'The test deployment needs attention.' });
  });

  it('is null whenever the primary card already tells the test deployment story', () => {
    for (const state of ['NOT_INSTALLED', 'WAITING_FOR_RELAY', 'INSTALLING', 'DELETING', 'FAILED', 'HEALTHY'] as const) {
      const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state })] }));
      expect(result.recentEvent, state).toBeNull();
    }
  });

  it('is null when there is no test deployment at all', () => {
    const result = deriveApplicationPresentation(makeInput());
    expect(result.recentEvent).toBeNull();
  });
});

describe('stale', () => {
  it('adds the stale notice without changing state', () => {
    const fresh = deriveApplicationPresentation(makeInput());
    const stale = deriveApplicationPresentation(makeInput({ stale: true }));
    expect(stale.state).toBe(fresh.state);
    expect(fresh.notices).toEqual([]);
    expect(stale.notices).toContainEqual({ tone: 'warning', text: STALE_NOTICE });
  });
});

// ── 9. customers-active ───────────────────────────────────────────────────────

describe('customers-active', () => {
  it('pluralises the heading', () => {
    const one = deriveApplicationPresentation(makeInput({ deployments: [customer({ id: 'c1' })] }));
    expect(one.heading).toBe('1 customer deployment');

    const two = deriveApplicationPresentation(
      makeInput({ deployments: [customer({ id: 'c1' }), customer({ id: 'c2' })] }),
    );
    expect(two.heading).toBe('2 customer deployments');
  });

  it('shows an attention message when a customer deployment failed', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        deployments: [customer({ id: 'c1', state: 'FAILED' }), customer({ id: 'c2', state: 'HEALTHY' })],
      }),
    );
    expect(result.message).toBe('1 deployment needs attention.');
  });

  it('does not count DELETING, DELETED or soft-deleted customer deployments', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        deployments: [
          customer({ id: 'c1', state: 'HEALTHY' }),
          customer({ id: 'c2', state: 'DELETING' }),
          customer({ id: 'c3', state: 'DELETED' }),
          customer({ id: 'c4', state: 'HEALTHY', deletedAt: '2026-09-01T00:00:00.000Z' }),
        ],
      }),
    );
    expect(result.heading).toBe('1 customer deployment');
  });

  it('does not count TEST deployments toward the customer total', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        deployments: [customer({ id: 'c1', state: 'HEALTHY' }), deployment({ id: 't1', state: 'HEALTHY' })],
      }),
    );
    expect(result.heading).toBe('1 customer deployment');
  });

  it('URL-encodes the application name in the view-deployments href', () => {
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [customer()], applicationName: 'Acme & Co' }),
    );
    expect(result.primaryAction).toMatchObject({
      id: 'view-customer-deployments',
      href: '/dashboard/deployments?application=Acme%20%26%20Co',
    });
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('latestTestDeployment', () => {
  it('returns null when there are no TEST deployments', () => {
    expect(latestTestDeployment([customer()])).toBeNull();
  });

  it('ignores DELETED and soft-deleted TEST deployments', () => {
    const list = [
      deployment({ id: 't1', state: 'DELETED' }),
      deployment({ id: 't2', state: 'HEALTHY', deletedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(latestTestDeployment(list)).toBeNull();
  });

  it('returns the newest surviving TEST deployment by createdAt, in either input order', () => {
    const older = deployment({ id: 't1', state: 'FAILED', createdAt: '2026-08-01T00:00:00.000Z' });
    const newer = deployment({ id: 't2', state: 'HEALTHY', createdAt: '2026-09-01T00:00:00.000Z' });
    expect(latestTestDeployment([older, newer])?.id).toBe('t2');
    expect(latestTestDeployment([newer, older])?.id).toBe('t2');
  });
});

describe('testDeploymentPhase', () => {
  it('is "none" for null', () => {
    expect(testDeploymentPhase(null)).toBe('none');
  });

  it.each([
    ['NOT_INSTALLED', 'queued'],
    ['WAITING_FOR_RELAY', 'deploying'],
    ['INSTALLING', 'deploying'],
    ['UPDATING', 'deploying'],
    ['DELETING', 'removing'],
    ['FAILED', 'failed'],
    ['DISCONNECTED', 'failed'],
    ['HEALTHY', 'verified'],
    ['UPDATE_AVAILABLE', 'verified'],
    ['MIGRATING', 'unknown'],
  ] as const)('%s → %s', (state, phase) => {
    expect(testDeploymentPhase(deployment({ state: state as FleetDeployment['state'] }))).toBe(phase);
  });
});

describe('customerDeployments', () => {
  it('keeps only live PRODUCTION deployments', () => {
    const list = [
      customer({ id: 'c1', state: 'HEALTHY' }),
      customer({ id: 'c2', state: 'DELETING' }),
      customer({ id: 'c3', state: 'DELETED' }),
      customer({ id: 'c4', deletedAt: '2026-09-01T00:00:00.000Z' }),
      deployment({ id: 't1', state: 'HEALTHY' }),
    ];
    expect(customerDeployments(list).map((d) => d.id)).toEqual(['c1']);
  });
});

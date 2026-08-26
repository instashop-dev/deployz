import { describe, expect, it } from 'vitest';

import type { Application } from '../src/lib/applications';
import type { FleetDeployment } from '../src/lib/deployments';
import type { DeploymentState } from '../src/lib/deployment-vocabulary';
import {
  attentionReason,
  deriveHomeState,
  isApplicationReady,
  preparationChecks,
  primaryApplication,
  sortForHomepage,
  summarise,
} from '../src/lib/home-state';

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'MyApp',
    githubInstallationId: 'install-1',
    repoFullName: 'acme/myapp',
    repoUrl: 'https://github.com/acme/myapp',
    defaultBranch: 'main',
    containerPort: 3000,
    healthPath: '/healthz',
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: true,
    storageRequired: false,
    redisRequired: false,
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    compatibilityReason: null,
    detectedMetadata: { hasDockerfile: true },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function deployment(overrides: Partial<FleetDeployment> = {}): FleetDeployment {
  return {
    id: 'dep-1',
    customerId: 'cus-1',
    applicationId: 'app-1',
    organizationId: 'org-1',
    region: 'us-east-1',
    state: 'HEALTHY',
    awsAccountId: '1234••••••',
    currentReleaseId: null,
    previousReleaseId: null,
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY',
    desiredState: {},
    observedState: null,
    infraVersion: 'runtime-v1',
    installationId: 'inst-1',
    isTestDeployment: false,
    lastHealthAt: null,
    deletedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme Corp',
    applicationName: 'MyApp',
    version: '1.4.2',
    ...overrides,
  };
}

describe('attentionReason', () => {
  it('flags failed and disconnected deployments', () => {
    expect(attentionReason(deployment({ state: 'FAILED' }))).toBe('Deployment failed');
    expect(attentionReason(deployment({ state: 'DISCONNECTED' }))).toBe('Deployment disconnected');
  });

  it('flags a healthy-state deployment whose health or relay says otherwise', () => {
    expect(attentionReason(deployment({ relayStatus: 'DISCONNECTED' }))).toBe(
      'Lost contact with this deployment',
    );
    expect(attentionReason(deployment({ healthStatus: 'UNHEALTHY' }))).toBe('Health check failing');
    expect(attentionReason(deployment({ healthStatus: 'DEGRADED' }))).toBe('Health check degraded');
  });

  it('leaves healthy, in-flight and not-yet-installed deployments alone', () => {
    expect(attentionReason(deployment())).toBeNull();
    expect(attentionReason(deployment({ state: 'INSTALLING' }))).toBeNull();
    expect(attentionReason(deployment({ state: 'UPDATE_AVAILABLE' }))).toBeNull();
    // Nobody has installed it yet, so its default health is not a problem.
    expect(attentionReason(deployment({ state: 'NOT_INSTALLED', relayStatus: 'UNKNOWN' }))).toBeNull();
    expect(attentionReason(deployment({ state: 'DELETING', healthStatus: 'UNHEALTHY' }))).toBeNull();
  });
});

describe('summarise', () => {
  it('counts each deployment exactly once, attention first', () => {
    const summary = summarise([
      deployment({ id: 'a' }),
      deployment({ id: 'b', state: 'UPDATE_AVAILABLE' }),
      deployment({ id: 'c', state: 'FAILED' }),
      deployment({ id: 'd', state: 'INSTALLING' }),
      deployment({ id: 'e', state: 'NOT_INSTALLED' }),
      // Unhealthy but still in the HEALTHY state: counted as attention, not healthy.
      deployment({ id: 'f', healthStatus: 'UNHEALTHY' }),
    ]);
    expect(summary).toEqual({ total: 6, healthy: 2, attention: 2, deploying: 1, waiting: 1 });
  });
});

describe('sortForHomepage', () => {
  it('puts problems first, then in-flight, then waiting, then the rest', () => {
    const rows = sortForHomepage([
      deployment({ id: 'healthy' }),
      deployment({ id: 'waiting', state: 'NOT_INSTALLED' }),
      deployment({ id: 'failed', state: 'FAILED' }),
      deployment({ id: 'installing', state: 'INSTALLING' }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['failed', 'installing', 'waiting', 'healthy']);
  });

  it('breaks ties by most recently updated', () => {
    const rows = sortForHomepage([
      deployment({ id: 'older', updatedAt: '2026-08-01T00:00:00.000Z' }),
      deployment({ id: 'newer', updatedAt: '2026-08-02T00:00:00.000Z' }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['newer', 'older']);
  });
});

describe('isApplicationReady / primaryApplication', () => {
  it('requires both a finished analysis and a READY verdict', () => {
    expect(isApplicationReady(application())).toBe(true);
    expect(isApplicationReady(application({ analysisStatus: 'ANALYZING' }))).toBe(false);
    expect(isApplicationReady(application({ compatibilityStatus: 'NEEDS_ATTENTION' }))).toBe(false);
  });

  it('prefers a ready application over a newer unready one', () => {
    const ready = application({ id: 'ready', createdAt: '2026-08-01T00:00:00.000Z' });
    const analysing = application({
      id: 'analysing',
      analysisStatus: 'ANALYZING',
      compatibilityStatus: null,
      createdAt: '2026-08-05T00:00:00.000Z',
    });
    expect(primaryApplication([ready, analysing])?.id).toBe('ready');
  });

  it('falls back to the newest application when none is ready', () => {
    const older = application({ id: 'older', analysisStatus: 'PENDING', compatibilityStatus: null });
    const newer = application({
      id: 'newer',
      analysisStatus: 'PENDING',
      compatibilityStatus: null,
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    expect(primaryApplication([older, newer])?.id).toBe('newer');
    expect(primaryApplication([])).toBeNull();
  });
});

describe('preparationChecks', () => {
  it('reports nothing as detected while analysis is still running', () => {
    const checks = preparationChecks(
      application({ analysisStatus: 'ANALYZING', compatibilityStatus: null }),
    );
    expect(checks.map((check) => check.state)).toEqual([
      'complete',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('reports the values the analyser actually persisted', () => {
    const checks = preparationChecks(application());
    expect(checks).toEqual([
      { label: 'Repository connected', detail: 'acme/myapp', state: 'complete' },
      { label: 'Runtime detected', detail: 'Docker', state: 'complete' },
      { label: 'Database detected', detail: 'PostgreSQL', state: 'complete' },
      { label: 'Health endpoint detected', detail: '/healthz', state: 'complete' },
      { label: 'Preparing deployment setup', detail: null, state: 'complete' },
    ]);
  });

  it('marks undetected things missing rather than inventing them, and reports no-DB as not required', () => {
    const checks = preparationChecks(
      application({ detectedMetadata: {}, databaseRequired: false, healthPath: null }),
    );
    // Runtime (no Dockerfile) and Health (no healthPath) are genuinely
    // missing; a database the app does not use is a complete "Not required"
    // state, not a missing detection.
    expect(checks.slice(1, 4).map((check) => check.state)).toEqual([
      'missing',
      'complete',
      'missing',
    ]);
    expect(checks[2]).toEqual({
      label: 'Database detected',
      detail: 'Not required',
      state: 'complete',
    });
  });
});

describe('deriveHomeState', () => {
  it('A — no application at all', () => {
    expect(deriveHomeState({ applications: [], deployments: [] })).toEqual({ kind: 'setup' });
  });

  it('B — an application that is not ready yet', () => {
    const state = deriveHomeState({
      applications: [application({ analysisStatus: 'ANALYZING', compatibilityStatus: null })],
      deployments: [],
    });
    expect(state.kind).toBe('preparing');
  });

  it('C — a ready application with no deployments', () => {
    const state = deriveHomeState({ applications: [application()], deployments: [] });
    expect(state.kind).toBe('ready');
  });

  it('D — a single deployment that is still being set up', () => {
    for (const state of ['NOT_INSTALLED', 'INSTALLING'] satisfies DeploymentState[]) {
      const home = deriveHomeState({
        applications: [application()],
        deployments: [deployment({ state })],
      });
      expect(home.kind).toBe('first-deployment');
    }
  });

  it('E — a single deployment that is past setup', () => {
    const home = deriveHomeState({
      applications: [application()],
      deployments: [deployment()],
    });
    expect(home.kind).toBe('operational');
  });

  it('E — deployments win over an application that is still being prepared', () => {
    const home = deriveHomeState({
      applications: [application({ analysisStatus: 'ANALYZING', compatibilityStatus: null })],
      deployments: [deployment({ id: 'a' }), deployment({ id: 'b' })],
    });
    expect(home.kind).toBe('operational');
  });

  it('ignores deleted deployments entirely', () => {
    const home = deriveHomeState({
      applications: [application()],
      deployments: [
        deployment({ id: 'gone', state: 'DELETED' }),
        deployment({ id: 'also-gone', deletedAt: '2026-08-03T00:00:00.000Z' }),
      ],
    });
    expect(home.kind).toBe('ready');
  });

  it('surfaces attention items and only names applications when there are several', () => {
    const home = deriveHomeState({
      applications: [application()],
      deployments: [
        deployment({ id: 'ok' }),
        deployment({ id: 'bad', state: 'FAILED' }),
        deployment({ id: 'other-app', applicationId: 'app-2' }),
      ],
    });
    if (home.kind !== 'operational') throw new Error(`expected operational, got ${home.kind}`);
    expect(home.attention.map((item) => item.deployment.id)).toEqual(['bad']);
    expect(home.attention[0]?.reason).toBe('Deployment failed');
    expect(home.showApplication).toBe(true);
    expect(home.deployments[0]?.id).toBe('bad');
  });
});

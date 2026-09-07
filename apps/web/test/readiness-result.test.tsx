import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  deriveLifecycleSteps,
  readinessHeaderPresentation,
  deriveReadinessRows,
  isFieldOverridden,
  effectiveFieldValue,
  detectedFieldValue,
  type ApplicationReadiness,
  type DetectedApplication,
  type DetectedFact,
  type FactSource,
} from '../src/lib/readiness';

/**
 * Component/DOM tests for the redesigned readiness page surfaces.
 *
 * The old ReadinessResult card is gone; its responsibilities now live in the
 * page header, the lifecycle stepper, and the deployment-readiness table.
 * These tests lock down the derivation logic that drives those surfaces.
 */

const fact = <T,>(value: T, source: FactSource = 'dockerfile'): DetectedFact<T> => ({
  value,
  source,
  confidence: source === 'source' || source === 'ai' ? 'likely' : 'confirmed',
  evidence: source === 'none' ? [] : [{ file: 'Dockerfile', reason: `Found in ${source}` }],
});

function detectedFixture(overrides: Partial<DetectedApplication> = {}): DetectedApplication {
  return {
    analysisVersion: 13,
    runtime: fact('node'),
    framework: fact('express', 'package-manifest'),
    build: fact('tsc', 'package-manifest'),
    start: fact('node dist/index.js'),
    network: { port: fact(3000), bindAddress: fact(null, 'none') },
    database: { required: true, type: 'postgres', confidence: 'confirmed', evidence: [{ reason: 'pg dependency' }] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: false, evidence: [] },
    healthCheck: { detected: true, path: '/health', confidence: 'confirmed', evidence: [{ reason: 'route' }] },
    migrations: { detected: true, command: 'npx drizzle-kit push', tools: ['drizzle-kit'], evidence: [{ reason: 'script' }] },
    environmentVariables: [],
    ...overrides,
  };
}

function applicationFixture(overrides: Partial<import('../src/lib/applications').Application> = {}): import('../src/lib/applications').Application {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Demo App',
    githubInstallationId: null,
    repoFullName: 'acme/demo',
    repoUrl: 'https://github.com/acme/demo',
    defaultBranch: 'main',
    containerPort: null,
    healthPath: null,
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: false,
    storageRequired: false,
    redisRequired: false,
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    compatibilityReason: null,
    detectedMetadata: null,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  } as import('../src/lib/applications').Application;
}

function readinessFixture(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'READY',
    requiredCount: 4,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [{ id: 'docker', label: 'Docker container detected' }],
    analyzedCommitSha: 'abc1234',
    detected: detectedFixture(),
    ...overrides,
  };
}

function render(input: ApplicationReadiness): Document {
  const header = readinessHeaderPresentation(input);
  const html = renderToString(
    <div>
      <h1>{header.heading}</h1>
      <p>{header.supportingLine}</p>
    </div>,
  );
  const { window } = new JSDOM(html);
  return window.document;
}

describe('Readiness page header — redesigned', () => {
  it('says the app is ready for test deployment when all required checks pass', () => {
    const doc = render(readinessFixture({ state: 'READY' }));
    expect(doc.body.textContent).toContain('Ready for test deployment');
    expect(doc.body.textContent).toContain('4 required checks passed');
  });

  it('never shows "X of Y" counts when the only gap is a recommendation', () => {
    const doc = render(
      readinessFixture({
        state: 'ALMOST_READY',
        recommendedCount: 1,
        findings: [
          {
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
          },
        ],
      }),
    );
    expect(doc.body.textContent).not.toMatch(/\d+ of \d+ checks passed/);
    expect(doc.body.textContent).toContain('recommendation');
  });

  it('shows blocker summary when required findings exist', () => {
    const doc = render(
      readinessFixture({
        state: 'NEEDS_CHANGES',
        requiredCount: 3,
        findings: [
          {
            id: 'health-check',
            category: 'health',
            title: 'Health endpoint missing',
            severity: 'required',
            blocking: true,
            plainEnglishExplanation: 'Deployz requires an HTTP health endpoint.',
            whyItMatters: 'Without it, Deployz cannot tell if your app is running.',
            technicalEvidence: 'No route responded on /health.',
            suggestedOutcome: 'Add a GET /health route that returns HTTP 200.',
            confidence: 'confirmed',
          },
        ],
      }),
    );
    expect(doc.body.textContent).toContain('Action required before deployment');
    expect(doc.body.textContent).toContain('2 of 3 required checks passed');
    expect(doc.body.textContent).toContain('1 blocking issue');
  });

  it('shows the failed analysis heading with the API reason', () => {
    const doc = render(
      readinessFixture({
        analysisStatus: 'FAILED',
        state: 'ANALYSIS_INCOMPLETE',
        failureReason: 'Failed to read the repository.',
      }),
    );
    expect(doc.body.textContent).toContain("We couldn't check deployment readiness");
    expect(doc.body.textContent).toContain('Failed to read the repository.');
  });
});

describe('Lifecycle stepper — redesigned', () => {
  it('marks analysis as done when complete', () => {
    const steps = deriveLifecycleSteps({
      analysisStatus: 'COMPLETE',
      readiness: readinessFixture(),
      deployments: [],
    });
    expect(steps.Analyze.state).toBe('done');
    expect(steps.Prepare.state).toBe('done');
    expect(steps['Customer ready'].state).toBe('pending');
  });

  it('marks test as verified when the latest test deployment is healthy', () => {
    const deployment = {
      id: 'dep-1',
      state: 'HEALTHY',
      isTestDeployment: true,
      createdAt: '2026-09-01T10:00:00Z',
    } as unknown as import('../src/lib/deployments').FleetDeployment;
    const steps = deriveLifecycleSteps({
      analysisStatus: 'COMPLETE',
      readiness: readinessFixture(),
      deployments: [deployment],
    });
    expect(steps.Test.state).toBe('done');
    expect(steps.Test.label).toBe('Verified');
    expect(steps['Customer ready'].state).toBe('done');
  });

  it('marks prepare as current when required findings exist', () => {
    const steps = deriveLifecycleSteps({
      analysisStatus: 'COMPLETE',
      readiness: readinessFixture({
        state: 'NEEDS_CHANGES',
        findings: [
          {
            id: 'health-check',
            category: 'health',
            title: 'Health endpoint missing',
            severity: 'required',
            blocking: true,
            plainEnglishExplanation: 'Deployz requires an HTTP health endpoint.',
            whyItMatters: 'Without it, Deployz cannot tell if your app is running.',
            technicalEvidence: 'No route responded on /health.',
            suggestedOutcome: 'Add a GET /health route that returns HTTP 200.',
            confidence: 'confirmed',
          },
        ],
      }),
      deployments: [],
    });
    expect(steps.Prepare.state).toBe('current');
    expect(steps.Prepare.label).toBe('Action required');
  });
});

describe('Deployment readiness table rows', () => {
  it('creates a setting row for every detected fact', () => {
    const rows = deriveReadinessRows(applicationFixture(), readinessFixture());
    const ids = rows.filter((r) => r.kind === 'setting').map((r) => r.id);
    expect(ids).toContain('runtime');
    expect(ids).toContain('port');
    expect(ids).toContain('health');
  });

  it('marks editable fields with their field key and detected value', () => {
    const rows = deriveReadinessRows(applicationFixture(), readinessFixture());
    const port = rows.find((r) => r.kind === 'setting' && r.id === 'port');
    expect(port).toMatchObject({ editable: true, field: 'containerPort', value: '3000', detectedValue: '3000' });
  });

  it('reports overridden values', () => {
    const app = applicationFixture({ containerPort: 8080 });
    const rows = deriveReadinessRows(app, readinessFixture());
    const port = rows.find((r) => r.kind === 'setting' && r.id === 'port');
    expect(port).toMatchObject({ value: '8080', detectedValue: '3000', overridden: true });
  });

  it('includes passed checks and findings', () => {
    const rows = deriveReadinessRows(
      applicationFixture(),
      readinessFixture({
        findings: [
          {
            id: 'health-check',
            category: 'health',
            title: 'Health endpoint missing',
            severity: 'required',
            blocking: true,
            plainEnglishExplanation: 'Deployz requires an HTTP health endpoint.',
            whyItMatters: 'Without it, Deployz cannot tell if your app is running.',
            technicalEvidence: 'No route responded on /health.',
            suggestedOutcome: 'Add a GET /health route that returns HTTP 200.',
            confidence: 'confirmed',
          },
        ],
      }),
    );
    expect(rows.some((r) => r.kind === 'passed' && r.id === 'docker')).toBe(true);
    expect(rows.some((r) => r.kind === 'finding' && r.id === 'health-check')).toBe(true);
  });

  it('shows rich detected fact text for boolean settings', () => {
    const app = applicationFixture({
      databaseRequired: true,
      storageRequired: false,
      redisRequired: false,
    });
    const rows = deriveReadinessRows(app, readinessFixture());
    const database = rows.find((r) => r.kind === 'setting' && r.id === 'database');
    expect(database?.value).toContain('PostgreSQL');
    expect(database?.detectedValue).toBe('Required');
  });
});

describe('Effective value / override resolution', () => {
  it('uses the application value when set', () => {
    const app = applicationFixture({ containerPort: 8080 });
    expect(effectiveFieldValue('containerPort', app, detectedFixture())).toBe('8080');
  });

  it('falls back to the detected value when the application value is not set', () => {
    const app = applicationFixture({ containerPort: null });
    expect(effectiveFieldValue('containerPort', app, detectedFixture())).toBe('3000');
  });

  it('detects an override when the application value differs from detected', () => {
    const app = applicationFixture({ containerPort: 8080 });
    expect(isFieldOverridden('containerPort', app, detectedFixture())).toBe(true);
  });

  it('does not detect an override when the values match', () => {
    const app = applicationFixture({ containerPort: 3000 });
    expect(isFieldOverridden('containerPort', app, detectedFixture())).toBe(false);
  });

  it('reports detected values as strings', () => {
    expect(detectedFieldValue('containerPort', detectedFixture())).toBe('3000');
    expect(detectedFieldValue('healthPath', detectedFixture())).toBe('/health');
  });
});

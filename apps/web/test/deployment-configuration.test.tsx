// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Application } from '../src/lib/applications';
import type {
  ApplicationReadiness,
  DetectedApplication,
  DetectedFact,
  FactSource,
  ReadinessFinding,
} from '../src/lib/readiness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Configuration tab's "Required changes" panel and its Fix routing — a
// required finding either opens the matching setting's edit dialog
// (port-unresolved only, today) or the fix-instructions dialog (everything
// else), and the panel is reachable and focusable via `#required-changes`.

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  reanalyse: vi.fn(),
  updateApplication: vi.fn(),
  generateFixInstructions: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return { ...actual, updateApplication: mocks.updateApplication };
});

vi.mock('@/lib/readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/readiness')>();
  return { ...actual, generateFixInstructions: mocks.generateFixInstructions };
});

function applicationFixture(overrides: Partial<Application> = {}): Application {
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
  };
}

const fact = <T,>(value: T, source: FactSource = 'dockerfile'): DetectedFact<T> => ({
  value,
  source,
  confidence: source === 'source' || source === 'ai' ? 'likely' : 'confirmed',
  evidence: source === 'none' ? [] : [{ file: 'Dockerfile', reason: `Found in ${source}` }],
});

function fullyDetected(): DetectedApplication {
  return {
    analysisVersion: 13,
    runtime: fact('node'),
    framework: fact('express', 'package-manifest'),
    build: fact('npm run build', 'package-manifest'),
    start: fact('node dist/index.js'),
    network: { port: fact(3000), bindAddress: fact(null, 'none') },
    database: { required: false, type: 'none', confidence: 'needs_confirmation', evidence: [] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: false, evidence: [] },
    healthCheck: { detected: false, path: null, confidence: 'needs_confirmation', evidence: [] },
    migrations: { detected: false, command: null, tools: [], evidence: [] },
    environmentVariables: [],
  };
}

function finding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
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
    ...overrides,
  };
}

function readinessFixture(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'NEEDS_CHANGES',
    requiredCount: 1,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [],
    analyzedCommitSha: 'abc1234',
    detected: fullyDetected(),
    requirements: { schemaVersion: 1, database: { detected: false, effective: false, overridden: false }, redis: { detected: false, effective: false, overridden: false }, storage: { detected: false, effective: false, overridden: false } },
    deploymentRequirementDrift: [],
    ...overrides,
  };
}

let currentApplication = applicationFixture();
let currentReadiness = readinessFixture();

vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({
    id: currentApplication.id,
    data: { application: currentApplication, readiness: currentReadiness, deployments: [], plan: null, installLinks: [] },
    loading: false,
    presentation: { readinessSummary: null, state: 'idle' },
    refresh: mocks.refresh,
    reanalyse: mocks.reanalyse,
    reanalysing: false,
  }),
}));

const { DeploymentConfiguration } = await import(
  '../src/app/dashboard/applications/[id]/config/deployment-configuration'
);

function byTestId(id: string): Element | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

async function click(element: Element | null): Promise<void> {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  currentApplication = applicationFixture();
  currentReadiness = readinessFixture();
  mocks.generateFixInstructions.mockReturnValue(new Promise(() => undefined)); // left pending by default
  window.location.hash = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  window.location.hash = '';
});

describe('Required changes panel', () => {
  it('lists each required finding with its plain-language label and explanation', async () => {
    currentReadiness = readinessFixture({
      findings: [
        finding({ id: 'health-check', category: 'health', severity: 'required' }),
        finding({
          id: 'port-unresolved',
          category: 'network',
          severity: 'required',
          title: 'Port not detected',
          plainEnglishExplanation: 'Deployz could not detect the port your app listens on.',
        }),
      ],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    const panel = byTestId('required-change-health-check')?.closest('#required-changes');
    expect(panel).not.toBeNull();
    expect(byTestId('required-change-health-check')?.textContent).toContain('Add a health check route');
    expect(byTestId('required-change-health-check')?.textContent).toContain(
      'Deployz requires an HTTP health endpoint.',
    );
    expect(byTestId('required-change-port-unresolved')?.textContent).toContain(
      'Set the port your app listens on',
    );
  });

  it('does not render when there are no required findings', async () => {
    currentReadiness = readinessFixture({ findings: [] });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(document.getElementById('required-changes')).toBeNull();
  });

  it('an instructions-type finding opens the fix-instructions dialog and notes the change is made in the repository', async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'container-setup', category: 'container', severity: 'required', title: 'No Dockerfile found' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('required-change-container-setup')?.textContent).toContain(
      'Change your repository, then re-analyse.',
    );
    await click(byTestId('required-change-fix-container-setup'));

    expect(byTestId('fix-instructions-dialog')).not.toBeNull();
    expect(mocks.generateFixInstructions).toHaveBeenCalled();
  });

  it('an edit-type finding (port-unresolved) opens the port editor, not fix instructions', async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'port-unresolved', category: 'network', severity: 'required', title: 'Port not detected' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    await click(byTestId('required-change-fix-port-unresolved'));

    expect(byTestId('edit-dialog-containerPort')).not.toBeNull();
    expect(byTestId('fix-instructions-dialog')).toBeNull();
    expect(mocks.generateFixInstructions).not.toHaveBeenCalled();
  });
});

describe('Table row Fix routing', () => {
  it("the health row's Fix opens fix instructions, never the health path editor", async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'health-check', category: 'health', severity: 'required' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    await click(byTestId('readiness-finding-fix-health-check'));

    expect(byTestId('fix-instructions-dialog')).not.toBeNull();
    expect(byTestId('edit-dialog-healthPath')).toBeNull();
  });

  it("the port row's Fix routes through the setting's own edit action (kind 'edit'), and opens the port editor", async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'port-unresolved', category: 'network', severity: 'required', title: 'Port not detected' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    // A required finding on the port row routes to kind 'edit' (never kind
    // 'fix'), so the button carries the setting-edit test id, not a
    // finding-fix one.
    expect(byTestId('readiness-finding-fix-port-unresolved')).toBeNull();
    await click(byTestId('readiness-setting-edit-port'));

    expect(byTestId('edit-dialog-containerPort')).not.toBeNull();
  });

  it('shows no Ready or Not used badge in the result column', async () => {
    currentReadiness = readinessFixture({ findings: [] });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    const runtimeRow = byTestId('readiness-setting-runtime');
    expect(runtimeRow?.querySelector('[data-slot="badge"]')).toBeNull();

    const redisRow = byTestId('readiness-setting-redis');
    expect(redisRow?.querySelector('[data-slot="badge"]')).toBeNull();
    expect(redisRow?.textContent).toContain('Not used');
  });

  it('still shows a badge for Change required / Recommended / Needs review', async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'health-check', category: 'health', severity: 'required' })],
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    const healthRow = byTestId('readiness-setting-health');
    expect(healthRow?.querySelector('[data-slot="badge"]')?.textContent).toBe('Change required');
  });
});

describe('#required-changes hash focus', () => {
  it('scrolls to and focuses the panel when the hash matches on load', async () => {
    currentReadiness = readinessFixture({
      findings: [finding({ id: 'health-check', category: 'health', severity: 'required' })],
    });
    window.location.hash = '#required-changes';

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(document.activeElement?.id).toBe('required-changes');
  });

  it('focuses the section heading when the hash matches but nothing is required', async () => {
    currentReadiness = readinessFixture({ findings: [] });
    window.location.hash = '#required-changes';

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(document.activeElement?.id).toBe('deployment-configuration');
  });
});

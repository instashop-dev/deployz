// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Application } from '../src/lib/applications';
import type {
  ApplicationArchitecture,
  ApplicationReadiness,
  DetectedApplication,
  DetectedFact,
  FactSource,
  ReadinessFinding,
} from '../src/lib/readiness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    database: { required: true, type: 'postgres', confidence: 'confirmed', evidence: [] },
    redis: { required: false, detected: false, supported: true, confidence: 'needs_confirmation', purposes: [], evidence: [] },
    storage: { persistentLocalRequired: false, objectStorageDetected: true, evidence: [] },
    healthCheck: { detected: false, path: null, confidence: 'needs_confirmation', evidence: [] },
    migrations: { detected: false, command: null, tools: [], evidence: [] },
    environmentVariables: [],
  };
}

function architectureFixture(): ApplicationArchitecture {
  return {
    counts: { total: 3, detected: 1, confirmed: 2 },
    groups: [
      { group: 'application', nodes: [{ label: 'Web service', state: 'confirmed' }] },
      { group: 'data', nodes: [{ label: 'PostgreSQL', state: 'confirmed' }] },
      { group: 'cache', nodes: [{ label: 'Redis', state: 'detected' }] },
    ],
    unresolved: [
      { kind: 'queue', question: 'Do you need a background queue?', blocking: false },
      { kind: 'port', question: 'Which port does your app listen on?', blocking: true },
    ],
  };
}

function readinessFixture(overrides: Partial<ApplicationReadiness> = {}): ApplicationReadiness {
  return {
    analysisStatus: 'COMPLETE',
    state: 'NEEDS_CHANGES',
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [],
    analyzedCommitSha: 'abc1234',
    detected: fullyDetected(),
    requirements: {
      schemaVersion: 1,
      database: { detected: true, effective: true, overridden: false },
      redis: { detected: false, effective: false, overridden: false },
      storage: { detected: true, effective: true, overridden: false },
    },
    deploymentRequirementDrift: [],
    architecture: architectureFixture(),
    ...overrides,
  };
}

let currentApplication = applicationFixture();
let currentReadiness = readinessFixture();

vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({
    id: currentApplication.id,
    data: {
      application: currentApplication,
      readiness: currentReadiness,
      deployments: [],
      plan: null,
      installLinks: [],
    },
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
  mocks.generateFixInstructions.mockReturnValue(new Promise(() => undefined));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('Configuration sections', () => {
  it('renders Application architecture with detected and confirmed statuses', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('application-architecture-section')).not.toBeNull();
    expect(byTestId('architecture-config-node-application-Web service')?.textContent).toContain(
      'Confirmed',
    );
    expect(byTestId('architecture-config-node-cache-Redis')?.textContent).toContain(
      'Detected automatically',
    );
  });

  it('renders Data & infrastructure with infrastructure rows', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('readiness-infrastructure-table')).not.toBeNull();
    expect(byTestId('readiness-setting-database')).not.toBeNull();
    expect(byTestId('readiness-setting-storage')).not.toBeNull();
  });

  it('renders Deployment preferences with non-infrastructure rows', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('readiness-table')).not.toBeNull();
    expect(byTestId('readiness-setting-runtime')).not.toBeNull();
    expect(byTestId('readiness-setting-port')).not.toBeNull();
  });

  it('shows unresolved architecture questions as Needs input cards with actions', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('architecture-config-unresolved')).not.toBeNull();
    expect(byTestId('architecture-unresolved-card-queue-0')?.textContent).toContain(
      'Do you need a background queue?',
    );
    expect(byTestId('architecture-unresolved-card-queue-0')?.textContent).toContain('Needs input');
    expect(byTestId('architecture-unresolved-fix-queue-0')).not.toBeNull();

    expect(byTestId('architecture-unresolved-card-port-1')?.textContent).toContain(
      'Which port does your app listen on?',
    );
    expect(byTestId('architecture-unresolved-edit-port-1')).not.toBeNull();
  });

  it('opens the fix-instructions dialog from an unresolved fix action', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    await click(byTestId('architecture-unresolved-fix-queue-0'));

    expect(byTestId('fix-instructions-dialog')).not.toBeNull();
    expect(mocks.generateFixInstructions).toHaveBeenCalled();
  });

  it('opens the edit dialog from an unresolved port action', async () => {
    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    await click(byTestId('architecture-unresolved-edit-port-1'));

    expect(byTestId('edit-dialog-containerPort')).not.toBeNull();
    expect(byTestId('fix-instructions-dialog')).toBeNull();
    expect(mocks.generateFixInstructions).not.toHaveBeenCalled();
  });

  it('hides the Application architecture section when no architecture data exists', async () => {
    currentReadiness = readinessFixture({ architecture: null });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('application-architecture-section')).toBeNull();
  });

  it('hides the Data & infrastructure section when analysis is incomplete and there is no plan', async () => {
    currentReadiness = readinessFixture({
      analysisStatus: 'PENDING',
      state: 'ANALYSIS_INCOMPLETE',
      detected: null,
      requirements: null,
      architecture: null,
    });

    await act(async () => {
      root.render(<DeploymentConfiguration />);
    });

    expect(byTestId('readiness-infrastructure-table')).toBeNull();
    expect(byTestId('application-architecture-section')).toBeNull();
  });
});

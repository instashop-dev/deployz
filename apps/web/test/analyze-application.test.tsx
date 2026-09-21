// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Analyse Application control (readiness-analyze) is the critical
// user-triggered action on the application Overview tab: this locks its
// loading treatment end to end — busy while pending, one call per click, a
// clean recovery (idle button + toast) when the request fails, and the
// "taking longer" restart offer. The page is mounted inside
// `ApplicationPageProvider`, the same provider the real layout uses, so the
// polling/timer/reanalyse behaviour under test is the real thing, not a
// stand-in.

const mocks = vi.hoisted(() => ({
  fetchApplication: vi.fn(),
  triggerAnalysis: vi.fn(),
  fetchApplicationPlan: vi.fn(),
  fetchReadiness: vi.fn(),
  fetchDeploymentsForApplication: vi.fn(),
  fetchPublicInstallLinks: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return {
    ...actual,
    fetchApplication: mocks.fetchApplication,
    triggerAnalysis: mocks.triggerAnalysis,
    fetchApplicationPlan: mocks.fetchApplicationPlan,
  };
});

vi.mock('@/lib/readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/readiness')>();
  return {
    ...actual,
    fetchReadiness: mocks.fetchReadiness,
  };
});

vi.mock('@/lib/deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deployments')>();
  return {
    ...actual,
    fetchDeploymentsForApplication: mocks.fetchDeploymentsForApplication,
  };
});

vi.mock('@/lib/public-install-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/public-install-links')>();
  return {
    ...actual,
    fetchPublicInstallLinks: mocks.fetchPublicInstallLinks,
  };
});

const { ApplicationPageProvider } = await import(
  '../src/app/dashboard/applications/[id]/application-page-context'
);
const ApplicationOverviewPage = (await import('../src/app/dashboard/applications/[id]/page')).default;
const { ANALYSIS_TAKING_LONGER_MS } = await import('../src/lib/readiness');

function baseApplication() {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Acme API',
    githubInstallationId: 'inst-1',
    repoFullName: 'acme/api',
    repoUrl: 'https://github.com/acme/api',
    defaultBranch: 'main',
    containerPort: null,
    healthPath: null,
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: false,
    storageRequired: false,
    redisRequired: false,
    analysisStatus: 'PENDING' as const,
    compatibilityStatus: null,
    compatibilityReason: null,
    detectedMetadata: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// Minimal valid shape per the ApplicationReadiness contract: a non-COMPLETE
// analysis carries ANALYSIS_INCOMPLETE and empty lists.
function baseReadiness() {
  return {
    analysisStatus: 'PENDING' as const,
    state: 'ANALYSIS_INCOMPLETE' as const,
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [],
    analyzedCommitSha: null,
    detected: null,
    requirements: null,
    deploymentRequirementDrift: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchApplication.mockResolvedValue(baseApplication());
  mocks.fetchReadiness.mockResolvedValue(baseReadiness());
  mocks.fetchDeploymentsForApplication.mockResolvedValue([]);
  mocks.fetchPublicInstallLinks.mockResolvedValue([]);
  // Only reached when analysisStatus is COMPLETE, but stubbed unconditionally
  // so any test that flips to COMPLETE does not need to remember it too.
  mocks.fetchApplicationPlan.mockResolvedValue(null);

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

function renderOverview(): void {
  root.render(
    <ApplicationPageProvider id="app-1">
      <ApplicationOverviewPage />
    </ApplicationPageProvider>,
  );
}

describe('Analyse application', () => {
  it('shows a busy spinner while pending, ignores a duplicate click, and recovers on failure', async () => {
    const trigger = deferred<void>();
    mocks.triggerAnalysis.mockReturnValue(trigger.promise);

    await act(async () => {
      renderOverview();
    });

    const button = () => container.querySelector('[data-testid="readiness-analyze"]') as HTMLButtonElement;

    expect(button()).not.toBeNull();
    expect(button().textContent).toBe('Analyse application');
    expect(button().disabled).toBe(false);

    await act(async () => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(button().textContent).toBe('Analysing application…');

    // A second click while disabled must not reach the handler.
    await act(async () => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(mocks.triggerAnalysis).toHaveBeenCalledTimes(1);

    await act(async () => {
      trigger.reject(new Error('boom'));
      await trigger.promise.catch(() => undefined);
    });

    expect(button().textContent).toBe('Analyse application');
    expect(button().disabled).toBe(false);
    expect(button().hasAttribute('aria-busy')).toBe(false);
    expect(mocks.toastError).toHaveBeenCalled();
  });
});

describe('Analysis in progress', () => {
  it('shows the server-side run as a busy heading and offers no button to re-trigger it', async () => {
    mocks.fetchApplication.mockResolvedValue({ ...baseApplication(), analysisStatus: 'ANALYZING' });
    mocks.fetchReadiness.mockResolvedValue({ ...baseReadiness(), analysisStatus: 'ANALYZING' });

    await act(async () => {
      renderOverview();
    });

    expect(container.querySelector('[data-testid="readiness-analyze"]')).toBeNull();

    const heading = container.querySelector('[data-testid="application-state-heading"]') as HTMLElement;
    expect(heading.textContent).toBe('Analysing your application');
    expect(heading.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(heading.getAttribute('aria-live')).toBe('polite');

    const lifecycle = container.querySelector('[data-testid="lifecycle-steps"]') as HTMLElement;
    expect(lifecycle).not.toBeNull();
    expect(lifecycle.textContent).toContain('Analyse');
  });

  it('offers a restart once the analysis has run for too long', async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchApplication.mockResolvedValue({ ...baseApplication(), analysisStatus: 'ANALYZING' });
      mocks.fetchReadiness.mockResolvedValue({ ...baseReadiness(), analysisStatus: 'ANALYZING' });
      mocks.triggerAnalysis.mockResolvedValue(undefined);

      await act(async () => {
        renderOverview();
      });
      expect(container.querySelector('[data-testid="readiness-restart"]')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ANALYSIS_TAKING_LONGER_MS);
      });

      const restart = container.querySelector('[data-testid="readiness-restart"]') as HTMLButtonElement;
      expect(restart).not.toBeNull();
      expect(restart.textContent).toBe('Restart analysis');
      expect(restart.disabled).toBe(false);
      const heading = container.querySelector('[data-testid="application-state-heading"]') as HTMLElement;
      expect(heading.textContent).toBe('Analysing your application');
      expect(container.textContent).toContain('This is taking longer than usual');

      await act(async () => {
        restart.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(mocks.triggerAnalysis).toHaveBeenCalledWith('app-1', { force: true });

      // A restart begins a new wait: the busy state returns until the
      // threshold elapses again.
      expect(container.querySelector('[data-testid="readiness-restart"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

function blocker(id: string) {
  return {
    id,
    category: 'runtime',
    title: `Blocker ${id}`,
    severity: 'required' as const,
    blocking: true,
    plainEnglishExplanation: 'The application cannot start.',
    whyItMatters: 'The deployment fails.',
    technicalEvidence: 'Dockerfile',
    suggestedOutcome: 'Fix the start command.',
    confidence: 'confirmed' as const,
  };
}

function blockedReadiness(ids: string[]) {
  return {
    ...baseReadiness(),
    analysisStatus: 'COMPLETE' as const,
    state: 'NEEDS_CHANGES' as const,
    requiredCount: ids.length,
    findings: ids.map(blocker),
    analyzedCommitSha: 'abcdef1234567',
  };
}

async function reviewLink(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const link = container.querySelector('[data-testid="readiness-review-blocker"]');
    if (!(link instanceof HTMLElement)) throw new Error('The page is still loading.');
    return link;
  });
}

describe('Blocking issues', () => {
  beforeEach(() => {
    mocks.fetchApplication.mockResolvedValue({ ...baseApplication(), analysisStatus: 'COMPLETE' });
  });

  it('shows the required-changes count and a Review configuration link to the Configuration tab', async () => {
    mocks.fetchReadiness.mockResolvedValue(blockedReadiness(['a', 'b']));

    await act(async () => {
      renderOverview();
    });

    const heading = await vi.waitFor(() => {
      const el = container.querySelector('[data-testid="application-state-heading"]');
      if (!(el instanceof HTMLElement) || !el.textContent) throw new Error('still loading');
      return el;
    });
    expect(heading.textContent).toBe('2 changes required');

    const review = await reviewLink();
    expect(review.textContent).toBe('Review configuration');
    expect(review.getAttribute('href')).toBe('/dashboard/applications/app-1/config');

    const items = container.querySelectorAll('[data-testid="application-state-heading"]');
    expect(items).toHaveLength(1);
  });
});

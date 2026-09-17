// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Analyze Application control (readiness-analyze) is the critical
// user-triggered action on the application readiness page: this locks its
// loading treatment end to end — busy while pending, one call per click, and
// a clean recovery (idle button + toast) when the request fails.

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  fetchApplication: vi.fn(),
  triggerAnalysis: vi.fn(),
  updateApplication: vi.fn(),
  deleteApplication: vi.fn(),
  fetchReadiness: vi.fn(),
  fetchDeploymentsForApplication: vi.fn(),
  fetchSubscriptionStatus: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'app-1' }),
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: mocks.replace }),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

// Rendered unconditionally at the top of the page; stub its one network call
// so mounting the page never makes a real request.
vi.mock('@/lib/billing-checkout', () => ({
  fetchSubscriptionStatus: mocks.fetchSubscriptionStatus,
}));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return {
    ...actual,
    fetchApplication: mocks.fetchApplication,
    triggerAnalysis: mocks.triggerAnalysis,
    updateApplication: mocks.updateApplication,
    deleteApplication: mocks.deleteApplication,
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

const ApplicationReadinessPage = (await import('../src/app/dashboard/applications/[id]/page'))
  .default;
const { ANALYSIS_TAKING_LONGER_MS, READINESS_SUPPORT_TAKING_LONGER } = await import(
  '../src/lib/readiness'
);

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

// Minimal valid shape per the §19 ApplicationReadiness contract (mirrors the
// "pending" fixture in test/readiness.test.ts): a non-COMPLETE analysis
// carries ANALYSIS_INCOMPLETE and empty lists.
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
  mocks.fetchSubscriptionStatus.mockResolvedValue(null);
  mocks.fetchApplication.mockResolvedValue(baseApplication());
  mocks.fetchReadiness.mockResolvedValue(baseReadiness());
  mocks.fetchDeploymentsForApplication.mockResolvedValue([]);

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

describe('Analyze application', () => {
  it('shows a busy spinner while pending, ignores a duplicate click, and recovers on failure', async () => {
    const trigger = deferred<void>();
    mocks.triggerAnalysis.mockReturnValue(trigger.promise);

    await act(async () => {
      root.render(<ApplicationReadinessPage />);
    });

    const button = () =>
      container.querySelector('[data-testid="readiness-analyze"]') as HTMLButtonElement;

    expect(button()).not.toBeNull();
    expect(button().textContent).toBe('Analyze application');
    expect(button().disabled).toBe(false);

    await act(async () => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(button().textContent).toBe('Analyzing application…');

    // A second click while disabled must not reach the handler.
    await act(async () => {
      button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(mocks.triggerAnalysis).toHaveBeenCalledTimes(1);

    await act(async () => {
      trigger.reject(new Error('boom'));
      await trigger.promise.catch(() => undefined);
    });

    expect(button().textContent).toBe('Analyze application');
    expect(button().disabled).toBe(false);
    expect(button().hasAttribute('aria-busy')).toBe(false);
    expect(mocks.toastError).toHaveBeenCalled();
  });
});

describe('Analysis in progress', () => {
  it('shows the server-side run as a busy state and never re-triggers on click', async () => {
    mocks.fetchApplication.mockResolvedValue({ ...baseApplication(), analysisStatus: 'ANALYZING' });
    mocks.fetchReadiness.mockResolvedValue({ ...baseReadiness(), analysisStatus: 'ANALYZING' });

    await act(async () => {
      root.render(<ApplicationReadinessPage />);
    });

    expect(container.querySelector('[data-testid="readiness-analyze"]')).toBeNull();
    const busy = container.querySelector('[data-testid="readiness-analyzing"]') as HTMLButtonElement;
    expect(busy).not.toBeNull();
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(busy.textContent).toBe('Analyzing application…');

    await act(async () => {
      busy.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(mocks.triggerAnalysis).not.toHaveBeenCalled();

    const heading = container.querySelector('[data-testid="readiness-heading"]') as HTMLElement;
    expect(heading.textContent).toBe('Analyzing application');
    expect(heading.querySelector('[data-slot="spinner"]')).not.toBeNull();

    const tableBody = container.querySelector('[data-testid="readiness-table"] tbody') as HTMLElement;
    expect(tableBody.getAttribute('aria-busy')).toBe('true');
    expect(tableBody.querySelectorAll('[data-testid="readiness-row-skeleton"]')).toHaveLength(3);
    expect(tableBody.textContent).toContain('Checking deployment readiness…');
  });

  it('offers a restart once the analysis has run for too long', async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchApplication.mockResolvedValue({ ...baseApplication(), analysisStatus: 'ANALYZING' });
      mocks.fetchReadiness.mockResolvedValue({ ...baseReadiness(), analysisStatus: 'ANALYZING' });
      mocks.triggerAnalysis.mockResolvedValue(undefined);

      await act(async () => {
        root.render(<ApplicationReadinessPage />);
      });
      expect(container.querySelector('[data-testid="readiness-restart"]')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ANALYSIS_TAKING_LONGER_MS);
      });

      const restart = container.querySelector('[data-testid="readiness-restart"]') as HTMLButtonElement;
      expect(restart).not.toBeNull();
      expect(restart.textContent).toBe('Restart analysis');
      expect(restart.disabled).toBe(false);
      const heading = container.querySelector('[data-testid="readiness-heading"]') as HTMLElement;
      expect(heading.nextElementSibling?.textContent).toBe(READINESS_SUPPORT_TAKING_LONGER);

      await act(async () => {
        restart.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      expect(mocks.triggerAnalysis).toHaveBeenCalledWith('app-1', { force: true });

      // A restart begins a new wait: the busy state returns until the
      // threshold elapses again.
      expect(container.querySelector('[data-testid="readiness-restart"]')).toBeNull();
      expect(container.querySelector('[data-testid="readiness-analyzing"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

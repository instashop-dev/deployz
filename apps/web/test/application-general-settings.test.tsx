// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Application } from '../src/lib/applications';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The General section of the Configuration tab: rename (with the exact old
// trim/no-op/toast rules) and the danger-zone delete flow, moved as is from
// the old overview page. These tests lock both down independently of the
// rest of the Configuration tab.

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  updateApplication: vi.fn(),
  deleteApplication: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('@/lib/applications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/applications')>();
  return {
    ...actual,
    updateApplication: mocks.updateApplication,
    deleteApplication: mocks.deleteApplication,
  };
});

function applicationFixture(overrides: Partial<Application> = {}): Application {
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
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    compatibilityReason: null,
    detectedMetadata: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let currentApplication = applicationFixture();

vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({
    id: currentApplication.id,
    data: { application: currentApplication, readiness: null, deployments: [], plan: null, installLinks: [] },
    loading: false,
    presentation: {},
    refresh: mocks.refresh,
    reanalyse: vi.fn(),
    reanalysing: false,
  }),
}));

const { GeneralSettings } = await import(
  '../src/app/dashboard/applications/[id]/config/general-settings'
);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
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
  currentApplication = applicationFixture();
  mocks.refresh.mockResolvedValue(undefined);
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

// The delete confirmation dialog renders through a Radix portal, outside
// `container` — query the whole document, as the old page's own test for
// this same flow does.
function byTestId(id: string): Element | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

async function click(element: Element | null): Promise<void> {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Rename application', () => {
  it('saves a trimmed name and shows a success toast', async () => {
    mocks.updateApplication.mockResolvedValue(applicationFixture({ name: 'New Name' }));

    await act(async () => {
      root.render(<GeneralSettings />);
    });

    const input = byTestId('app-name-input') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, '  New Name  ');
    });
    await click(byTestId('app-name-save'));

    expect(mocks.updateApplication).toHaveBeenCalledWith('app-1', { name: 'New Name' });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Application renamed.');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the name is unchanged', async () => {
    await act(async () => {
      root.render(<GeneralSettings />);
    });

    await click(byTestId('app-name-save'));

    expect(mocks.updateApplication).not.toHaveBeenCalled();
  });

  it('does nothing when the name is blank', async () => {
    await act(async () => {
      root.render(<GeneralSettings />);
    });

    const input = byTestId('app-name-input') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, '   ');
    });
    await click(byTestId('app-name-save'));

    expect(mocks.updateApplication).not.toHaveBeenCalled();
  });

  it('shows a toast and keeps the input when the save fails', async () => {
    mocks.updateApplication.mockRejectedValue(new Error('boom'));

    await act(async () => {
      root.render(<GeneralSettings />);
    });

    const input = byTestId('app-name-input') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 'New Name');
    });
    await click(byTestId('app-name-save'));

    expect(mocks.toastError).toHaveBeenCalledWith("We couldn't rename the application. Try again in a moment.");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe('Delete application', () => {
  const HISTORY_MESSAGE =
    'This application has deployment history and cannot be removed. Applications can only be removed before their first deployment.';

  it('keeps the confirm button disabled until the exact repository name is typed', async () => {
    await act(async () => {
      root.render(<GeneralSettings />);
    });

    await click(byTestId('delete-app-trigger'));
    const confirmButton = byTestId('delete-app-button') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    const input = byTestId('delete-app-confirm') as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 'acme/ap');
    });
    expect((byTestId('delete-app-button') as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.deleteApplication).not.toHaveBeenCalled();

    await act(async () => {
      setInputValue(input, 'acme/api');
    });
    expect((byTestId('delete-app-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('redirects to the applications list on success', async () => {
    mocks.deleteApplication.mockResolvedValue(undefined);

    await act(async () => {
      root.render(<GeneralSettings />);
    });

    await click(byTestId('delete-app-trigger'));
    await act(async () => {
      setInputValue(byTestId('delete-app-confirm') as HTMLInputElement, 'acme/api');
    });
    await click(byTestId('delete-app-button'));

    expect(mocks.deleteApplication).toHaveBeenCalledWith('app-1');
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/applications');
  });

  it('keeps the dialog open and shows the server message for APPLICATION_HAS_DEPLOYMENTS', async () => {
    const deletion = deferred<void>();
    mocks.deleteApplication.mockReturnValue(deletion.promise);

    await act(async () => {
      root.render(<GeneralSettings />);
    });

    await click(byTestId('delete-app-trigger'));
    await act(async () => {
      setInputValue(byTestId('delete-app-confirm') as HTMLInputElement, 'acme/api');
    });
    await click(byTestId('delete-app-button'));

    await act(async () => {
      deletion.reject(Object.assign(new Error(HISTORY_MESSAGE), { code: 'APPLICATION_HAS_DEPLOYMENTS' }));
      await deletion.promise.catch(() => undefined);
    });

    expect(byTestId('delete-app-confirm')).not.toBeNull();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(HISTORY_MESSAGE);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('shows the generic failure message for any other error', async () => {
    const deletion = deferred<void>();
    mocks.deleteApplication.mockReturnValue(deletion.promise);

    await act(async () => {
      root.render(<GeneralSettings />);
    });

    await click(byTestId('delete-app-trigger'));
    await act(async () => {
      setInputValue(byTestId('delete-app-confirm') as HTMLInputElement, 'acme/api');
    });
    await click(byTestId('delete-app-button'));

    await act(async () => {
      deletion.reject(new Error('database exploded'));
      await deletion.promise.catch(() => undefined);
    });

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "We couldn't remove this application. Try again in a moment.",
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

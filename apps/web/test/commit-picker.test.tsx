// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// cmdk's CommandList and Radix's Popper positioning both observe element
// size via ResizeObserver, which jsdom does not implement; cmdk also scrolls
// the selected item into view on mount. Neither matters for these
// assertions, so both are stubbed to no-ops (matches create-deployment-page.test.tsx).
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
Element.prototype.scrollIntoView = () => {};

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'app-1' }),
}));

const mocks = vi.hoisted(() => ({
  fetchReleases: vi.fn(),
  createRelease: vi.fn(),
  fetchDeploymentsForApplication: vi.fn(),
  fetchCommits: vi.fn(),
  resolveCommit: vi.fn(),
}));

vi.mock('@/lib/releases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/releases')>();
  return { ...actual, fetchReleases: mocks.fetchReleases, createRelease: mocks.createRelease };
});

vi.mock('@/lib/deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deployments')>();
  return { ...actual, fetchDeploymentsForApplication: mocks.fetchDeploymentsForApplication };
});

vi.mock('@/lib/commits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/commits')>();
  return { ...actual, fetchCommits: mocks.fetchCommits, resolveCommit: mocks.resolveCommit };
});

vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({ data: { application: { defaultBranch: 'main' } } }),
}));

const { ApiRequestError } = await import('../src/lib/api-client');
const ReleasesPage = (await import('../src/app/dashboard/applications/[id]/releases/page')).default;
type Commit = import('../src/lib/commits').Commit;
type Release = import('../src/lib/releases').Release;
type CommitsPage = import('../src/lib/commits').CommitsPage;

function commit(overrides: Partial<Commit> = {}): Commit {
  return {
    sha: `${'b2806f9'}${'0'.repeat(33)}`,
    shortSha: 'b2806f9',
    title: 'Fix deployment configuration',
    authorName: 'Jane',
    committedAt: '2026-09-23T10:00:00Z',
    ...overrides,
  };
}

const OLDER_COMMIT = commit({
  sha: `${'41bd7c2'}${'1'.repeat(33)}`,
  shortSha: '41bd7c2',
  title: 'Add health endpoint',
  authorName: 'Sam',
  committedAt: '2026-09-01T10:00:00Z',
});

function commitsPage(overrides: Partial<CommitsPage> = {}): CommitsPage {
  return {
    repoFullName: 'acme/app',
    branch: 'main',
    commits: [commit(), OLDER_COMMIT],
    nextPage: null,
    ...overrides,
  };
}

function release(overrides: Partial<Release> = {}): Release {
  return {
    id: 'rel-1',
    version: 'v0.1.0',
    status: 'READY',
    failureReason: null,
    gitSha: 'a'.repeat(40),
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];

async function renderPage(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<ReleasesPage />);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

function click(el: Element | null): void {
  if (!el) throw new Error('element not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function openForm(container: HTMLElement): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Create Release',
  );
  await act(async () => {
    click(button ?? null);
  });
}

function commitPickerTrigger(): HTMLButtonElement {
  return document.getElementById('commit-picker-trigger') as HTMLButtonElement;
}

async function openPicker(): Promise<void> {
  await act(async () => {
    click(commitPickerTrigger());
  });
}

function commandItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-slot="command-item"]'));
}

async function selectCommitOption(label: string): Promise<void> {
  const option = commandItems().find((item) => (item.textContent ?? '').includes(label));
  await act(async () => {
    click(option ?? null);
  });
}

// Scoped to the form: the page's own "Create Release"/"Cancel" toggle button
// has no explicit `type`, so the DOM's native default also reports it as
// "submit" — matching against the whole container would find that button
// instead of the form's real submit button.
function releaseForm(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="create-release-form"]') as HTMLElement;
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  return Array.from(releaseForm(container).querySelectorAll('button')).find(
    (button) => button.type === 'submit',
  ) as HTMLButtonElement;
}

async function fillVersion(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector('#version') as HTMLInputElement;
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(container: HTMLElement): Promise<void> {
  await fillVersion(container, 'v1.0.0');
  await act(async () => {
    submitButton(container).click();
  });
}

// cmdk's CommandInput and the manual-SHA Input are React-controlled (their
// `value` always comes from state), so React installs a value tracker on
// the DOM node; a plain `input.value = x` assignment updates that tracker
// too, and React then sees no change and never fires onChange. The native
// setter bypasses the tracker, matching how @testing-library/user-event
// types into controlled inputs.
function setControlledValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function flushMicrotasks(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.fetchReleases.mockReset().mockResolvedValue([]);
  mocks.createRelease.mockReset().mockResolvedValue(release({ id: 'new-rel' }));
  mocks.fetchDeploymentsForApplication.mockReset().mockResolvedValue([]);
  mocks.fetchCommits.mockReset().mockResolvedValue(commitsPage());
  mocks.resolveCommit.mockReset();
});

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
});

describe('CommitPicker on the New release form', () => {
  it('loads recent commits, preselects the newest, and shows the branch context', async () => {
    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();

    expect(mocks.fetchCommits).toHaveBeenCalledWith('app-1', 1);
    expect(container.textContent).toContain('Commits from main');
    expect(commitPickerTrigger().textContent).toContain('b2806f9');
    expect(commitPickerTrigger().textContent).toContain('Fix deployment configuration');
  });

  it('submits the full SHA of the preselected newest commit unchanged', async () => {
    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();

    await submit(container);
    await flushMicrotasks();

    expect(mocks.createRelease).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ gitSha: commit().sha }),
    );
  });

  it('search filters by commit title', async () => {
    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await openPicker();

    const input = document.querySelector('[data-slot="command-input"]') as HTMLInputElement;
    await act(async () => {
      setControlledValue(input, 'health');
    });

    const visible = commandItems().map((item) => item.textContent ?? '');
    expect(visible.some((text) => text.includes('Add health endpoint'))).toBe(true);
    expect(visible.some((text) => text.includes('Fix deployment configuration'))).toBe(false);
  });

  it('search filters by short SHA', async () => {
    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await openPicker();

    const input = document.querySelector('[data-slot="command-input"]') as HTMLInputElement;
    await act(async () => {
      setControlledValue(input, '41bd7c2');
    });

    const visible = commandItems().map((item) => item.textContent ?? '');
    expect(visible.some((text) => text.includes('Add health endpoint'))).toBe(true);
    expect(visible.some((text) => text.includes('Fix deployment configuration'))).toBe(false);
  });

  it('selecting another commit and submitting sends its full SHA', async () => {
    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await openPicker();
    await selectCommitOption('Add health endpoint');

    expect(commitPickerTrigger().textContent).toContain('41bd7c2');

    await submit(container);
    await flushMicrotasks();

    expect(mocks.createRelease).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ gitSha: OLDER_COMMIT.sha }),
    );
  });

  it('shows "Already released as vX" when the selected commit matches an existing release', async () => {
    mocks.fetchReleases.mockResolvedValue([release({ version: 'v0.1.0', gitSha: commit().sha })]);

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();

    expect(container.textContent).toContain('Already released as v0.1.0');
  });

  it('loads more commits on demand and appends the next page', async () => {
    mocks.fetchCommits.mockImplementation((_id: string, page: number) =>
      Promise.resolve(
        page === 1
          ? commitsPage({ commits: [commit()], nextPage: 2 })
          : commitsPage({ commits: [OLDER_COMMIT], nextPage: null }),
      ),
    );

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await openPicker();

    expect(commandItems().some((item) => (item.textContent ?? '').includes('Add health endpoint'))).toBe(
      false,
    );

    const loadMore = commandItems().find((item) => (item.textContent ?? '').includes('Load more commits'));
    await act(async () => {
      click(loadMore ?? null);
    });
    await flushMicrotasks();

    expect(mocks.fetchCommits).toHaveBeenCalledWith('app-1', 2);
    expect(commandItems().some((item) => (item.textContent ?? '').includes('Add health endpoint'))).toBe(
      true,
    );
  });

  it('shows an error with Retry, and Retry recovers and preselects the newest commit', async () => {
    mocks.fetchCommits
      .mockRejectedValueOnce(new ApiRequestError('GITHUB_RATE_LIMITED', 'rate limited'))
      .mockResolvedValueOnce(commitsPage());

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();

    expect(container.textContent).toContain('GitHub is limiting requests right now. Wait a minute, then retry.');

    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry');
    await act(async () => {
      click(retry ?? null);
    });
    await flushMicrotasks();

    expect(mocks.fetchCommits).toHaveBeenCalledTimes(2);
    expect(commitPickerTrigger().textContent).toContain('b2806f9');
  });

  it('shows the GITHUB_NOT_CONNECTED message', async () => {
    mocks.fetchCommits.mockRejectedValue(
      new ApiRequestError('GITHUB_NOT_CONNECTED', 'not connected'),
    );

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();

    expect(container.textContent).toContain(
      'GitHub is not connected for this application. Reconnect GitHub, or enter a commit SHA manually.',
    );
  });

  it('names the configured branch when it no longer exists', async () => {
    mocks.fetchCommits.mockRejectedValue(
      new ApiRequestError('GITHUB_BRANCH_NOT_FOUND', 'No commit found'),
    );

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();

    expect(container.textContent).toContain('The main branch no longer exists in the repository.');
    expect(container.textContent).toContain('Commits from main');
    expect(container.textContent).toContain('Enter commit SHA manually');
  });

  it('shows the empty-repository message and the manual fallback', async () => {
    mocks.fetchCommits.mockResolvedValue(commitsPage({ commits: [], nextPage: null }));

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();

    expect(container.textContent).toContain('This branch has no commits yet.');
    expect(container.textContent).toContain('Enter commit SHA manually');
  });

  async function switchToManual(container: HTMLElement): Promise<void> {
    const link = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Enter commit SHA manually',
    );
    await act(async () => {
      click(link ?? null);
    });
  }

  function manualInput(): HTMLInputElement {
    return document.getElementById('gitShaManual') as HTMLInputElement;
  }

  async function typeManual(value: string): Promise<void> {
    await act(async () => {
      setControlledValue(manualInput(), value);
    });
  }

  it('manual mode: rejects a value that is not 7-40 hex characters', async () => {
    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await switchToManual(container);
    await typeManual('xyz');

    await submit(container);
    await flushMicrotasks();

    expect(container.textContent).toContain('Paste a commit SHA from GitHub: 7 to 40 letters (a–f) and digits.');
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });

  it('manual mode: resolves a short SHA to the full SHA on submit', async () => {
    mocks.resolveCommit.mockResolvedValue(commit());

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await switchToManual(container);
    await typeManual('b2806f9');

    await submit(container);
    await flushMicrotasks();

    expect(mocks.resolveCommit).toHaveBeenCalledWith('app-1', 'b2806f9');
    expect(mocks.createRelease).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ gitSha: commit().sha }),
    );
  });

  it('manual mode: COMMIT_NOT_FOUND blocks submission', async () => {
    mocks.resolveCommit.mockRejectedValue(new ApiRequestError('COMMIT_NOT_FOUND', 'not found'));

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await switchToManual(container);
    await typeManual('abc1234');

    await submit(container);
    await flushMicrotasks();

    expect(container.textContent).toContain("This commit doesn't exist in the repository.");
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });

  it('manual mode: a GitHub failure still lets a full 40-char SHA submit', async () => {
    mocks.resolveCommit.mockRejectedValue(new Error('network down'));
    const fullSha = 'c'.repeat(40);

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await switchToManual(container);
    await typeManual(fullSha);

    await submit(container);
    await flushMicrotasks();

    expect(mocks.createRelease).toHaveBeenCalledWith('app-1', expect.objectContaining({ gitSha: fullSha }));
  });

  it('manual mode: a GitHub failure blocks a short SHA', async () => {
    mocks.resolveCommit.mockRejectedValue(new Error('network down'));

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();
    await switchToManual(container);
    await typeManual('abc1234');

    await submit(container);
    await flushMicrotasks();

    expect(container.textContent).toContain(
      "GitHub is unavailable, so we can't check a short SHA. Enter the full 40-character SHA.",
    );
    expect(mocks.createRelease).not.toHaveBeenCalled();
  });

  it('a retry after an error preselects the newest commit, and a later manual selection is not reverted', async () => {
    mocks.fetchCommits
      .mockRejectedValueOnce(new ApiRequestError('GITHUB_RATE_LIMITED', 'rate limited'))
      .mockResolvedValueOnce(commitsPage());

    const container = await renderPage();
    await openForm(container);
    await flushMicrotasks();

    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry');
    await act(async () => {
      click(retry ?? null);
    });
    await flushMicrotasks();

    expect(commitPickerTrigger().textContent).toContain('b2806f9');

    await openPicker();
    await selectCommitOption('Add health endpoint');
    expect(commitPickerTrigger().textContent).toContain('41bd7c2');

    await submit(container);
    await flushMicrotasks();

    expect(mocks.createRelease).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ gitSha: OLDER_COMMIT.sha }),
    );
  });
});

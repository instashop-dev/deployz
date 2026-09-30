// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A1-006: a stored analysis older than the current analyser shows a notice
// with a Re-analyse action on every tab; it never starts an analysis itself.

const mocks = vi.hoisted(() => ({ reanalyse: vi.fn() }));

let page: {
  analysisOutdated: boolean;
  state: string;
  reanalysing: boolean;
};

vi.mock('../src/app/dashboard/applications/[id]/application-page-context', () => ({
  useApplicationPage: () => ({
    id: 'app-1',
    data: {
      application: { name: 'Demo', repoFullName: 'acme/demo' },
      readiness: { analyzedCommitSha: 'abc1234def', analysisOutdated: page.analysisOutdated },
    },
    loading: false,
    presentation: { state: page.state, badge: { variant: 'secondary', label: 'Ready' } },
    refresh: vi.fn(),
    reanalyse: mocks.reanalyse,
    reanalysing: page.reanalysing,
  }),
}));

const { ApplicationHeader } = await import('../src/app/dashboard/applications/[id]/application-header');

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  page = { analysisOutdated: true, state: 'ready', reanalysing: false };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => root.render(<ApplicationHeader />));
}

describe('ApplicationHeader outdated-analysis notice', () => {
  it('shows the notice without a version number and re-analyses on click', () => {
    render();
    const notice = container.querySelector('[data-testid="application-analysis-outdated"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).not.toMatch(/\d/);
    expect(mocks.reanalyse).not.toHaveBeenCalled();

    const button = container.querySelector<HTMLButtonElement>('[data-testid="application-analysis-outdated-reanalyse"]');
    act(() => button!.click());
    expect(mocks.reanalyse).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when the analysis is current', () => {
    page.analysisOutdated = false;
    render();
    expect(container.querySelector('[data-testid="application-analysis-outdated"]')).toBeNull();
  });

  it('shows nothing while an analysis is running', () => {
    page.state = 'analysing';
    render();
    expect(container.querySelector('[data-testid="application-analysis-outdated"]')).toBeNull();
  });

  it('disables the action while a re-analysis starts', () => {
    page.reanalysing = true;
    render();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="application-analysis-outdated-reanalyse"]');
    expect(button?.disabled).toBe(true);
  });
});

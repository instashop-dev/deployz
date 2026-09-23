// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildFailureDetails } from '../src/lib/release-build-failure';
import type { Release } from '../src/lib/releases';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchBuildFailure: vi.fn(),
  fetchBuildLog: vi.fn(),
  explainBuildFailure: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

vi.mock('@/lib/release-build-failure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/release-build-failure')>();
  return {
    ...actual,
    fetchBuildFailure: mocks.fetchBuildFailure,
    fetchBuildLog: mocks.fetchBuildLog,
    explainBuildFailure: mocks.explainBuildFailure,
  };
});

const { buildInvestigationPrompt, buildSupportReport, buildTechnicalDetails } = await import(
  '../src/lib/release-build-failure'
);
const { ReleaseFailureDetails } = await import('../src/components/release-failure-details');

const SHA = 'efa70adbc63e'.padEnd(40, '7');
const FINAL_CHECK_REASON =
  'CodeBuild reported FAILED — BUILD: COMMAND_EXECUTION_ERROR: Error while executing command: if [ ... ]; then echo "The image build did not produce an image" >&2; exit 1; fi. Reason: exit status 1';

function details(overrides: Partial<BuildFailureDetails> = {}): BuildFailureDetails {
  return {
    releaseId: 'rel-1',
    version: 'efa70adbc63e',
    gitSha: SHA,
    repository: 'instashop-dev/crypto',
    branch: 'main',
    stage: 'build',
    stageLabel: 'Building the image from your Dockerfile',
    summary: 'The version could not be built from the repository.',
    failureReason: FINAL_CHECK_REASON,
    finalCheckOnly: true,
    buildReference: '0f1e2d3c',
    logs: { status: 'available', lineCount: 3, truncated: false },
    observedError: null,
    evidence: {
      observedError: null,
      failedStep: null,
      dockerfilePath: 'Dockerfile',
      buildContext: '.',
      excerpt: [
        { number: 1, text: '#9 [builder 5/7] RUN npm run build', error: false },
        { number: 2, text: '#9 DONE 12.0s', error: false },
        { number: 3, text: 'The image build did not produce an image', error: false },
      ],
    },
    cause: {
      owner: 'undetermined',
      basis: '"The image build did not produce an image" is a final check. It is not the cause, and no earlier error was found.',
      nextStep: 'Deployz could not find the cause in the available evidence.',
    },
    ...overrides,
  };
}

const release: Release = {
  id: 'rel-1',
  version: 'efa70adbc63e',
  status: 'FAILED',
  failureReason: FINAL_CHECK_REASON,
  gitSha: SHA,
  createdAt: '2026-09-23T17:22:39.781Z',
};

describe('investigation prompt', () => {
  it('states verified facts only and asks for investigation before any change', () => {
    const prompt = buildInvestigationPrompt(details());
    expect(prompt).toContain('Investigation prompt');
    expect(prompt).toContain('NOT confirmed');
    expect(prompt).toContain('Repository: instashop-dev/crypto');
    expect(prompt).toContain(`Commit: ${SHA}`);
    expect(prompt).toContain('Failed stage: Building the image from your Dockerfile');
    expect(prompt).toContain('It is not the cause.');
    expect(prompt).toContain('Earliest error found: none found in the available evidence');
    expect(prompt).toContain('Do not change code yet');
    expect(prompt).toContain("Deployz's build pipeline");
    expect(prompt).toContain('Do not guess');
    expect(prompt).toContain('3: The image build did not produce an image');
    expect(prompt).not.toMatch(/root cause is|the fix is|to fix this,/i);
  });

  it('asks for logs when none are available', () => {
    const prompt = buildInvestigationPrompt(details({ logs: { status: 'unavailable', lineCount: 0, truncated: false }, evidence: null }));
    expect(prompt).toContain('No build log lines are available.');
    expect(prompt).toContain('View build logs');
  });

  it('labels an AI reading as unverified', () => {
    const prompt = buildInvestigationPrompt(details(), {
      status: 'explained',
      likelyCause: 'A type error.',
      supportingLines: [{ number: 2, text: '#9 DONE 12.0s' }],
      nextStep: 'Fix it.',
      confidence: 'medium',
      uncertainty: 'Only the end of the log was read.',
    });
    expect(prompt).toContain('Unverified AI reading');
    expect(prompt).toContain('Treat this as a lead, not a fact.');
  });

  it('builds technical details and a support report from the same data', () => {
    expect(buildTechnicalDetails(details())).toContain('Build reference: 0f1e2d3c');
    expect(buildSupportReport(details())).toContain('Possible Deployz build issue');
  });
});

describe('ReleaseFailureDetails', () => {
  let container: HTMLElement;
  let root: Root;
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderPanel(): Promise<void> {
    await act(async () => {
      root.render(<ReleaseFailureDetails applicationId="app-1" release={release} onCreateRelease={() => {}} />);
    });
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="release-failure-details-rel-1"]')) throw new Error('loading');
    });
  }

  function button(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
  }

  it('says the cause is unknown when only the final check was found, and copies the investigation prompt', async () => {
    mocks.fetchBuildFailure.mockResolvedValue(details());
    await renderPanel();
    expect(container.textContent).toContain('Cause not determined');
    expect(container.textContent).toContain('The cause is unknown.');
    expect(container.textContent).toContain('is a final check that runs after the build. It is not the cause.');
    expect(button('Copy report for Deployz support')).toBeUndefined();

    await act(async () => {
      button('Copy prompt for coding agent')!.click();
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`Commit: ${SHA}`));
  });

  it('offers a support report instead of the coding-agent prompt for a Deployz-side failure', async () => {
    mocks.fetchBuildFailure.mockResolvedValue(
      details({ cause: { owner: 'deployz', basis: 'Only Deployz commands run in this step.', nextStep: 'Send it to Deployz support.' } }),
    );
    await renderPanel();
    expect(button('Copy report for Deployz support')).toBeDefined();
    expect(button('Copy prompt for coding agent')).toBeUndefined();
  });

  it('works without logs: states why, and disables log and AI actions', async () => {
    mocks.fetchBuildFailure.mockResolvedValue(
      details({ logs: { status: 'no_build', lineCount: 0, truncated: false }, evidence: null }),
    );
    await renderPanel();
    expect(container.querySelector('[data-testid="release-failure-log-status"]')?.textContent).toContain(
      'failed before the image build started',
    );
    expect(button('View build logs')?.disabled).toBe(true);
    expect(button('Explain with AI')?.disabled).toBe(true);
    expect(button('Copy technical details')?.disabled).toBe(false);
  });

  it('keeps the details when the AI fails', async () => {
    mocks.fetchBuildFailure.mockResolvedValue(details());
    mocks.explainBuildFailure.mockRejectedValue(new Error('The AI explanation is not available right now.'));
    await renderPanel();
    await act(async () => {
      button('Explain with AI')!.click();
    });
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="release-ai-error"]')) throw new Error('waiting');
    });
    expect(container.querySelector('[data-testid="release-failure-next-step"]')).not.toBeNull();
  });

  it('says so when the AI reading is inconclusive', async () => {
    mocks.fetchBuildFailure.mockResolvedValue(details());
    mocks.explainBuildFailure.mockResolvedValue({ status: 'inconclusive', uncertainty: 'The excerpt shows no error.' });
    await renderPanel();
    await act(async () => {
      button('Explain with AI')!.click();
    });
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="release-ai-inconclusive"]')) throw new Error('waiting');
    });
    expect(container.textContent).toContain('The AI could not find the cause in these log lines.');
  });

  it('shows the stored summary and a retry when the details cannot load', async () => {
    mocks.fetchBuildFailure.mockRejectedValue(new Error("We couldn't load the failure details."));
    await act(async () => {
      root.render(<ReleaseFailureDetails applicationId="app-1" release={release} onCreateRelease={() => {}} />);
    });
    await vi.waitFor(() => {
      if (!container.querySelector('[data-testid="release-failure-error"]')) throw new Error('waiting');
    });
    expect(button('Try again')).toBeDefined();
  });
});

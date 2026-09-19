// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CustomerDeploymentStatus, DeploymentStep } from '@deployz/contracts';

import { TAKING_LONGER_MESSAGE } from '../src/lib/deployment-progress';
import { OWNERSHIP_NOTE } from '../src/lib/security-details';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const mocks = vi.hoisted(() => ({
  fetchInstallStatus: vi.fn(),
  fetchDomainAccess: vi.fn(),
}));

vi.mock('../src/lib/install-status', () => ({
  fetchInstallStatus: mocks.fetchInstallStatus,
}));

// CustomDomainCard (rendered once the stage grants Access) fetches domain
// access on mount — stub it so mounting a READY/VERIFYING state never makes
// a real request. Every other export of the module (pure copy/labels) stays
// real.
vi.mock('../src/lib/domains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/domains')>();
  return { ...actual, fetchDomainAccess: mocks.fetchDomainAccess };
});

const { InstallProgress } = await import('../src/components/install-progress');

const STEPS: DeploymentStep[] = [
  'AWS_SETUP',
  'RELAY_CONNECT',
  'PREPARING',
  'NETWORK',
  'DATABASE_STORAGE',
  'MIGRATION',
  'APPLICATION',
  'HEALTH_CHECK',
  'TLS',
  'READY',
];

function baseStatus(overrides: Partial<CustomerDeploymentStatus> = {}): CustomerDeploymentStatus {
  return {
    stage: 'PROVISIONING',
    updatedAt: '2026-09-18T00:00:00.000Z',
    currentActivity: 'Creating the database.',
    step: 'DATABASE_STORAGE',
    steps: STEPS,
    typicalDurationSeconds: { min: 180, max: 600 },
    takingLongerThanUsual: false,
    removed: false,
    statusUpdatesUnavailable: false,
    needsDomainSetup: false,
    components: [],
    url: null,
    failure: null,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof InstallProgress>[0]> = {}) {
  return {
    installLinkId: 'link-1',
    deploymentId: 'dep-1',
    initialStatus: null,
    quickCreateUrl: null,
    initialDomain: null,
    routingTarget: null,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: ReturnType<typeof baseProps>): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<InstallProgress {...props} />);
  });
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
  mocks.fetchInstallStatus.mockReset();
  mocks.fetchDomainAccess.mockReset();
});

describe('InstallProgress — success flow', () => {
  it('shows the live step detail, recent activity, keeps Technical details closed by default, then goes quiet on READY', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:20:00.000Z'));

    const stepStartedAt = new Date(Date.now() - (4 * 60_000 + 12_000)).toISOString(); // 4m12s ago
    let current = baseStatus({
      stepStartedAt,
      recentActivity: [
        { key: 'a1', at: new Date(Date.now() - 60_000).toISOString(), message: 'Network created.', state: 'COMPLETE' },
        { key: 'a2', at: new Date(Date.now() - 5_000).toISOString(), message: 'Creating the database.', state: 'IN_PROGRESS' },
      ],
      technicalDetails: {
        reference: 'REF-123',
        facts: [{ label: 'Stack status', value: 'CREATE_IN_PROGRESS' }],
        events: [
          {
            at: new Date(Date.now() - 10_000).toISOString(),
            logicalResourceId: 'DatabaseInstance',
            resourceType: 'AWS::RDS::DBInstance',
            resourceStatus: 'CREATE_IN_PROGRESS',
            resourceStatusReason: null,
          },
        ],
      },
    });
    mocks.fetchInstallStatus.mockImplementation(() => Promise.resolve(current));
    mocks.fetchDomainAccess.mockResolvedValue({ canManage: false, domain: null });

    mount(baseProps({ initialStatus: current }));
    await flush();

    const text = () => container!.textContent ?? '';

    expect(text()).toContain('Creating database & storage');
    expect(text()).toContain('Creating the database.');
    expect(text()).toContain('Usually takes 3–10 minutes');
    expect(text()).toContain('4m 12s elapsed');
    expect(text()).toContain('Checked just now');
    expect(text()).toContain('Recent AWS activity');
    expect(text()).toContain('Network created.');

    // Jargon confined to the collapsed disclosure: closed by default, Radix
    // does not render its children, so none of the raw facts/events show up
    // in the visible text yet.
    expect(text()).not.toContain('CREATE_IN_PROGRESS');
    expect(text()).not.toContain('DatabaseInstance');
    expect(text()).not.toContain('REF-123');

    const trigger = container!.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    await act(async () => {
      click(trigger);
    });
    expect(text()).toContain('CREATE_IN_PROGRESS');
    expect(text()).toContain('REF-123');
    expect(text()).toContain('DatabaseInstance');

    // The deployment finishes: the next poll returns READY.
    current = baseStatus({ stage: 'READY', step: 'READY', url: 'https://app.example.com', removed: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(text()).not.toContain('elapsed');
    expect(text()).not.toContain('Recent AWS activity');
    expect(text()).toContain('Your application is ready');
    expect(text()).toContain('Access');
    const callsAtReady = mocks.fetchInstallStatus.mock.calls.length;

    // Terminal (READY): terminalIntervalMs is null, so no further polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(mocks.fetchInstallStatus.mock.calls.length).toBe(callsAtReady);
  });
});

describe('InstallProgress — long-running flow', () => {
  it('grows the elapsed time; the checked time counts up while a poll stalls, then resets to "just now" once it lands', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const stepStartedAt = new Date(Date.now()).toISOString();
    const status = baseStatus({ stepStartedAt });

    // First fetch (on mount) resolves immediately; the next one (at the 5s
    // poll mark) hangs until resolved manually, so real time can pass beyond
    // the last successful check.
    let resolveStalled!: (value: CustomerDeploymentStatus) => void;
    mocks.fetchInstallStatus
      .mockResolvedValueOnce(status)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStalled = resolve)));

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).toContain('0s elapsed');
    expect(text()).toContain('Checked just now');

    // The poll fires at 5s and stalls; three more seconds pass on the
    // 1-second ticker with no successful check yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(text()).toContain('8s elapsed');
    expect(text()).toContain('Checked 8 seconds ago');

    // The stalled poll finally lands: checked resets to "just now".
    resolveStalled(status);
    await flush();
    expect(text()).toContain('Checked just now');
  });

  it('shows the exact reassuring sentence when taking longer than usual', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ takingLongerThanUsual: true, stepStartedAt: new Date().toISOString() });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    expect(container!.textContent ?? '').toContain(TAKING_LONGER_MESSAGE);
  });

  it('the HTTPS step waiting on the customer keeps its fixed copy — no elapsed counter, no "still working" nudge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      stage: 'VERIFYING',
      step: 'TLS',
      needsDomainSetup: true,
      takingLongerThanUsual: true,
      typicalDurationSeconds: null,
      stepStartedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    const text = container!.textContent ?? '';
    expect(text).toContain('Waiting for a custom domain to be added.');
    expect(text).not.toContain('elapsed');
    expect(text).not.toMatch(/still working/);
  });

  it('renders the starting-application step through the same live detail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      step: 'APPLICATION',
      currentActivity: 'Starting the application.',
      stepStartedAt: new Date().toISOString(),
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('Starting application');
    expect(text).toContain('Starting the application.');
    expect(text).toContain('elapsed');
  });

  it('says when live AWS activity starts while no connector can report it, and not before launch or after', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const note = 'Live AWS activity appears here when Deployz starts to create your infrastructure.';
    const waiting = baseStatus({
      stage: 'WAITING_FOR_AWS',
      step: 'AWS_SETUP',
      currentActivity: 'AWS is creating the Deployz connector in your account.',
      stepStartedAt: new Date().toISOString(),
    });
    mocks.fetchInstallStatus.mockResolvedValue(waiting);

    mount(baseProps({ initialStatus: waiting }));
    await flush();
    expect(container!.textContent).toContain('AWS is creating the Deployz connector in your account.');
    expect(container!.textContent).toContain(note);

    mocks.fetchInstallStatus.mockResolvedValue(
      baseStatus({ stage: 'CONNECTING', step: 'RELAY_CONNECT', currentActivity: 'The connector is ready.' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(container!.textContent).toContain(note);

    mocks.fetchInstallStatus.mockResolvedValue(baseStatus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(container!.textContent).not.toContain(note);
  });

  it('does not promise AWS activity before the customer presses Deploy to AWS', async () => {
    vi.useFakeTimers();
    const waiting = baseStatus({ stage: 'WAITING_FOR_AWS', step: 'AWS_SETUP' });
    mocks.fetchInstallStatus.mockResolvedValue(waiting);

    mount(baseProps({ initialStatus: waiting, awaitingLaunch: true }));
    await flush();

    expect(container!.textContent).not.toContain('Live AWS activity appears here');
  });

  it('a payload without the new optional fields still renders the plain duration line and does not crash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    // No stepStartedAt/recentActivity/provisioningIssue/technicalDetails —
    // the older-API mixed-version window (§brief).
    const status = baseStatus();
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('Usually takes 3–10 minutes');
    expect(text).not.toContain('elapsed');
    expect(text).not.toContain('Recent AWS activity');
  });
});

describe('InstallProgress — failure flow', () => {
  it('shows the AWS-reported-a-problem alert immediately during PROVISIONING', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ provisioningIssue: { message: 'A database resource failed to create.' } });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = container!.textContent ?? '';
    expect(text).toContain('AWS reported a problem');
    expect(text).toContain('A database resource failed to create.');
  });

  it('a FAILED payload shows the friendly message, with the raw reason inside opened Technical details', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({
      stage: 'FAILED',
      step: 'DATABASE_STORAGE',
      failure: {
        customerMessage: 'Deployz could not finish setting up your infrastructure.',
        component: 'database',
        reference: 'REF-999',
        technical: { stage: 'PROVISIONING', component: 'database', awsStatus: 'Resource creation failed' },
      },
      technicalDetails: {
        reference: 'REF-999',
        facts: [{ label: 'Stack status', value: 'ROLLBACK_COMPLETE' }],
        events: [
          {
            at: new Date().toISOString(),
            logicalResourceId: 'DatabaseInstance',
            resourceType: 'AWS::RDS::DBInstance',
            resourceStatus: 'CREATE_FAILED',
            resourceStatusReason: 'The parameter MasterUserPassword is not a valid password.',
          },
        ],
      },
    });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).toContain('Deployment needs attention');
    expect(text()).toContain('Deployz could not finish setting up your infrastructure.');
    expect(text()).not.toContain('ROLLBACK_COMPLETE');
    expect(text()).not.toContain('is not a valid password');

    const trigger = container!.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement;
    await act(async () => {
      click(trigger);
    });
    expect(text()).toContain('ROLLBACK_COMPLETE');
    expect(text()).toContain('is not a valid password');
  });
});

describe('InstallProgress — AWS deployment details (READY)', () => {
  const summary = {
    applicationStackName: 'deployz-app-abcd1234',
    region: 'us-east-1',
    releaseVersion: 'v1.4.2',
  };

  function readyStatus(overrides: Partial<CustomerDeploymentStatus> = {}): CustomerDeploymentStatus {
    return baseStatus({ stage: 'READY', step: 'READY', url: 'https://app.example.com', ...overrides });
  }

  async function openSummaryTrigger(): Promise<() => string> {
    const trigger = Array.from(container!.querySelectorAll('[data-slot="collapsible-trigger"]')).find((element) =>
      element.textContent?.includes('AWS deployment details'),
    ) as HTMLElement | undefined;
    expect(trigger).toBeDefined();
    await act(async () => {
      click(trigger!);
    });
    return () => container!.textContent ?? '';
  }

  it('READY with awsSummary renders the collapsed summary, the CloudFormation link, and the ownership note', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = readyStatus({ awsSummary: summary });
    mocks.fetchInstallStatus.mockResolvedValue(status);
    mocks.fetchDomainAccess.mockResolvedValue({ canManage: false, domain: null });

    mount(baseProps({ initialStatus: status }));
    await flush();

    const closedText = container!.textContent ?? '';
    // Collapsed by default: the trigger and the note, none of the rows.
    expect(closedText).toContain('AWS deployment details');
    expect(closedText).toContain(OWNERSHIP_NOTE);
    expect(closedText).not.toContain(summary.applicationStackName);

    const text = await openSummaryTrigger();
    expect(text()).toContain(summary.applicationStackName);
    expect(text()).toContain('us-east-1');
    expect(text()).toContain(summary.releaseVersion);
    expect(text()).toContain('Last checked');
    expect(text()).toContain('https://app.example.com');

    const consoleLink = Array.from(container!.querySelectorAll('a')).find((anchor) =>
      anchor.getAttribute('href')?.includes('cloudformation'),
    );
    expect(consoleLink).toBeDefined();
    expect(consoleLink!.getAttribute('href')).toBe(
      `https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=${summary.applicationStackName}`,
    );
    expect(consoleLink!.getAttribute('target')).toBe('_blank');
    expect(consoleLink!.getAttribute('rel')).toBe('noreferrer');
  });

  it('READY without awsSummary renders no summary section', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = readyStatus();
    mocks.fetchInstallStatus.mockResolvedValue(status);
    mocks.fetchDomainAccess.mockResolvedValue({ canManage: false, domain: null });

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).not.toContain('AWS deployment details');
    expect(text()).not.toContain(OWNERSHIP_NOTE);
  });

  it('a non-READY stage renders no summary, even when awsSummary is present', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const status = baseStatus({ awsSummary: summary });
    mocks.fetchInstallStatus.mockResolvedValue(status);

    mount(baseProps({ initialStatus: status }));
    await flush();

    const text = () => container!.textContent ?? '';
    expect(text()).not.toContain('AWS deployment details');
    expect(text()).not.toContain(summary.applicationStackName);
    expect(text()).not.toContain(OWNERSHIP_NOTE);
  });
});

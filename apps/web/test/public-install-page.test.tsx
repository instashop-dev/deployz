// @vitest-environment jsdom

import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentPlan, PublicInstallResolve } from '../src/lib/public-install-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { Element?: { prototype: { scrollIntoView?: unknown } } }).Element!.prototype.scrollIntoView = vi.fn();

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => routerMocks }));

const confirmMocks = vi.hoisted(() => ({ confirmPublicInstall: vi.fn() }));
vi.mock('../src/lib/public-install-confirm', () => ({
  confirmPublicInstall: confirmMocks.confirmPublicInstall,
}));

const pageMocks = vi.hoisted(() => ({
  fetchPublicInstallData: vi.fn(),
  fetchInstallData: vi.fn(),
  fetchInstallStatusServer: vi.fn(),
}));
vi.mock('../src/lib/public-install-data', () => ({
  fetchPublicInstallData: pageMocks.fetchPublicInstallData,
}));
vi.mock('../src/lib/install-data', () => ({
  fetchInstallData: pageMocks.fetchInstallData,
  launchInstall: vi.fn(),
}));
vi.mock('../src/lib/install-status', () => ({
  fetchInstallStatusServer: pageMocks.fetchInstallStatusServer,
}));

const InstallPage = (await import('../src/app/install/[installLinkId]/page')).default;
const { PublicInstallFlow } = await import('../src/components/public-install-flow');

const LINK_ID = '11111111-1111-1111-1111-111111111111';

function planFixture(): DeploymentPlan {
  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: null,
    components: [
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' as const },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' as const },
      { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' as const },
    ],
    awsResources: [
      {
        id: 'ecs_service',
        name: 'ECS Fargate service',
        purpose: 'Runs the application container and restarts it if it stops',
        group: 'compute_networking' as const,
        componentKind: 'application' as const,
        lifecycle: 'delete' as const,
      },
      {
        id: 'database',
        name: 'RDS PostgreSQL database',
        purpose: 'Stores persistent application data',
        group: 'data' as const,
        componentKind: 'database' as const,
        lifecycle: 'retain' as const,
      },
    ],
    requirementDrift: [],
  };
}

function resolveFixture(overrides: Partial<PublicInstallResolve> = {}): PublicInstallResolve {
  return {
    application: { name: 'Acme App' },
    publisher: { name: 'Acme Inc' },
    release: { version: '1.2.0', createdAt: '2026-09-01T00:00:00.000Z' },
    regions: [
      { value: 'us-east-1', label: 'US East (N. Virginia)' },
      { value: 'us-west-2', label: 'US West (Oregon)' },
    ],
    requiredInputs: [
      { key: 'API_KEY', required: true, secret: true },
      { key: 'ORG_NAME', required: true, secret: false },
      { key: 'WEBHOOK_URL', required: false, secret: false },
    ],
    plan: planFixture(),
    ...overrides,
  };
}

async function renderServer(linkId: string = LINK_ID): Promise<Document> {
  const element = await InstallPage({
    params: Promise.resolve({ installLinkId: linkId }),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

const cleanups: Array<() => void> = [];

function renderFlow(resolve: PublicInstallResolve = resolveFixture()): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PublicInstallFlow linkId={LINK_ID} resolve={resolve} />);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * React tracks value on the instance, so assigning `.value` directly makes
 * React ignore the following input event. Set through the prototype's native
 * setter so the dispatched event reaches React's onChange.
 */
function typeInto(element: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('InstallPage public resolution', () => {
  beforeEach(() => {
    pageMocks.fetchPublicInstallData.mockReset();
    pageMocks.fetchInstallData.mockReset();
    pageMocks.fetchInstallStatusServer.mockReset().mockResolvedValue(null);
  });

  it('renders the public confirm flow when the link resolves', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue({ status: 'ok', data: resolveFixture() });
    const doc = await renderServer();

    expect(doc.body.textContent).toContain('Acme App');
    expect(doc.body.textContent).toContain('Acme Inc');
    expect(doc.body.textContent).toContain('Release 1.2.0');
    expect(doc.body.textContent).toContain('US East (N. Virginia)');
    expect(doc.body.textContent).toContain('API_KEY');
    expect(doc.body.textContent).toContain('Application');
    expect(doc.body.textContent).toContain('Secure endpoint');
    expect(doc.body.textContent).toContain('Database');
    expect(doc.body.textContent).toContain(
      'PostgreSQL and stored files are retained when the application is disconnected. They can continue to generate AWS charges until they are permanently purged.',
    );
  });

  it('renders public-flow error copy for a disabled public link', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue({
      status: 'gone',
      code: 'PUBLIC_INSTALL_LINK_DISABLED',
    });
    const doc = await renderServer();

    expect(doc.body.textContent).toContain('This application cannot be installed');
    expect(doc.body.textContent).toContain(
      'This application is not currently available for installation. Contact the publisher.',
    );
  });

  it('renders public-flow error copy for a revoked public link', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue({
      status: 'gone',
      code: 'PUBLIC_INSTALL_LINK_REVOKED',
    });
    const doc = await renderServer();

    expect(doc.body.textContent).toContain('This application cannot be installed');
    expect(doc.body.textContent).toContain(
      'This installation link has been revoked. Contact the publisher for a new link.',
    );
  });

  it('renders public-flow error copy when no release is published', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue({
      status: 'gone',
      code: 'RELEASE_NOT_PUBLISHED',
    });
    const doc = await renderServer();

    expect(doc.body.textContent).toContain('This application has no published release yet');
  });

  it('falls through to the per-deployment flow when the public link is unknown', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue(null);
    pageMocks.fetchInstallData.mockResolvedValue({
      applicationName: 'Existing App',
      publisherName: 'Existing Publisher',
      customerName: 'Customer',
      region: 'us-east-1',
      plan: null,
      quickCreateUrl: 'https://quick.create',
      alreadyInstalled: false,
      deploymentId: 'dep-1',
      deploymentState: 'NOT_INSTALLED',
      domain: null,
      routingTarget: null,
      bootstrapStackName: 'bootstrap',
      waitingForRelay: false,
      relayStuck: false,
      components: null,
    });

    const doc = await renderServer();

    expect(doc.body.textContent).toContain('to your AWS account');
    expect(pageMocks.fetchInstallData).toHaveBeenCalledWith(LINK_ID);
  });
});

describe('PublicInstallFlow', () => {
  beforeEach(() => {
    confirmMocks.confirmPublicInstall.mockReset();
    routerMocks.push.mockReset();
    vi.stubGlobal('crypto', { randomUUID: () => 'idem-key-1' });
  });

  afterEach(() => {
    while (cleanups.length) {
      cleanups.pop()?.();
    }
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders identity, release, region select, required inputs, secret password fields, plan and retention sentence', () => {
    renderFlow();

    expect(document.body.textContent).toContain('Acme App');
    expect(document.body.textContent).toContain('Acme Inc');
    expect(document.body.textContent).toContain('Release 1.2.0');

    const secretInput = document.querySelector('input#API_KEY') as HTMLInputElement;
    expect(secretInput).not.toBeNull();
    expect(secretInput.type).toBe('password');

    const plainInput = document.querySelector('input#ORG_NAME') as HTMLInputElement;
    expect(plainInput).not.toBeNull();
    expect(plainInput.type).toBe('text');

    expect(document.body.textContent).toContain('Application');
    expect(document.body.textContent).toContain('Secure endpoint');
    expect(document.body.textContent).toContain('Database');
    expect(document.body.textContent).toContain(
      'PostgreSQL and stored files are retained when the application is disconnected. They can continue to generate AWS charges until they are permanently purged.',
    );
  });

  it('only offers regions from the resolved list', async () => {
    renderFlow();

    const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    await act(async () => {
      click(trigger);
    });

    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    expect(Array.from(options).map((option) => option.textContent)).toEqual([
      'US East (N. Virginia)',
      'US West (Oregon)',
    ]);
    expect(document.body.textContent).not.toContain('Europe (Ireland)');
  });

  it('disables deploy until all required values are filled', async () => {
    renderFlow();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const apiKey = document.querySelector('input#API_KEY') as HTMLInputElement;
    const orgName = document.querySelector('input#ORG_NAME') as HTMLInputElement;
    const customerName = document.querySelector('input#customer-name') as HTMLInputElement;
    const customerEmail = document.querySelector('input#customer-email') as HTMLInputElement;

      await act(async () => {
      typeInto(apiKey, 'secret-key');
      typeInto(orgName, 'Acme');
    });

    expect(button.disabled).toBe(true);

    await act(async () => {
      typeInto(customerName, 'Ada Lovelace');
      typeInto(customerEmail, 'ada@example.com');
    });

    expect(button.disabled).toBe(false);
  });

  it('posts the confirm body with a stable idempotency key and navigates on success', async () => {
    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: true, installLinkId: 'new-link-id' });
    renderFlow();

    await fillForm();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(button);
    });

    expect(confirmMocks.confirmPublicInstall).toHaveBeenCalledTimes(1);
    expect(confirmMocks.confirmPublicInstall).toHaveBeenCalledWith(LINK_ID, {
      idempotencyKey: 'idem-key-1',
      region: 'us-east-1',
      customer: { name: 'Ada Lovelace', email: 'ada@example.com' },
      config: [
        { key: 'API_KEY', value: 'secret-key', isSecret: true },
        { key: 'ORG_NAME', value: 'Acme', isSecret: false },
      ],
    });
    expect(routerMocks.push).toHaveBeenCalledWith('/install/new-link-id');
  });

  it('ignores a second click while pending and re-uses the same idempotency key on retry', async () => {
    const def = deferred<{ ok: false; code: string }>();
    confirmMocks.confirmPublicInstall.mockReturnValue(def.promise);
    renderFlow();

    await fillForm();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(button);
    });

    click(button);
    expect(confirmMocks.confirmPublicInstall).toHaveBeenCalledTimes(1);

    await act(async () => {
      def.resolve({ ok: false, code: 'PUBLIC_INSTALL_CONFIG_INVALID' });
    });

    // Retry after error.
    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: true, installLinkId: 'new-link-id' });
    const retryButton = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(retryButton);
    });

    expect(confirmMocks.confirmPublicInstall).toHaveBeenCalledTimes(2);
    expect(confirmMocks.confirmPublicInstall.mock.calls[1]![0]).toBe(LINK_ID);
    expect(confirmMocks.confirmPublicInstall.mock.calls[1]![1].idempotencyKey).toBe('idem-key-1');
  });

  it('shows actionable error copy for SUBSCRIPTION_REQUIRED and PUBLIC_INSTALL_CONFIG_INVALID', async () => {
    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: false, code: 'SUBSCRIPTION_REQUIRED' });
    renderFlow();

    await fillForm();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(button);
    });

    expect(document.body.textContent).toContain(
      'The publisher must fix their Deployz subscription before this application can be installed. Contact the publisher.',
    );

    confirmMocks.confirmPublicInstall.mockResolvedValue({
      ok: false,
      code: 'PUBLIC_INSTALL_CONFIG_INVALID',
    });
    const retryButton = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(retryButton);
    });

    expect(document.body.textContent).toContain(
      'Some configuration values are missing or not valid. Check the fields and try again.',
    );
  });
});

async function fillForm(): Promise<void> {
  const apiKey = document.querySelector('input#API_KEY') as HTMLInputElement;
  const orgName = document.querySelector('input#ORG_NAME') as HTMLInputElement;
  const customerName = document.querySelector('input#customer-name') as HTMLInputElement;
  const customerEmail = document.querySelector('input#customer-email') as HTMLInputElement;

  await act(async () => {
    typeInto(apiKey, 'secret-key');
    typeInto(orgName, 'Acme');
    typeInto(customerName, 'Ada Lovelace');
    typeInto(customerEmail, 'ada@example.com');
  });
}

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// cmdk's CommandList and Radix's Popper positioning both observe element
// size via ResizeObserver, which jsdom does not implement; cmdk also scrolls
// the selected item into view on mount. Neither matters for these
// assertions, so both are stubbed to no-ops.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
Element.prototype.scrollIntoView = () => {};

const searchParamsMocks = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsMocks.query),
}));

const mocks = vi.hoisted(() => ({
  fetchApplications: vi.fn(),
  fetchCustomers: vi.fn(),
  createCustomerRecord: vi.fn(),
  createDeploymentRecord: vi.fn(),
  createInvitation: vi.fn(),
  fetchRegions: vi.fn(),
  fetchApplicationPreflight: vi.fn(),
}));

vi.mock('../src/lib/applications', () => ({
  fetchApplications: mocks.fetchApplications,
}));

vi.mock('../src/lib/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/customers')>();
  return { ...actual, fetchCustomers: mocks.fetchCustomers, createInvitation: mocks.createInvitation };
});

vi.mock('../src/lib/deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deployments')>();
  return {
    ...actual,
    createCustomerRecord: mocks.createCustomerRecord,
    createDeploymentRecord: mocks.createDeploymentRecord,
  };
});

vi.mock('../src/lib/regions', () => ({
  fetchRegions: mocks.fetchRegions,
}));

vi.mock('../src/lib/preflight', () => ({
  fetchApplicationPreflight: mocks.fetchApplicationPreflight,
}));

const NewDeploymentPage = (await import('../src/app/dashboard/deployments/new/page')).default;
type Customer = import('../src/lib/customers').Customer;
type Application = import('../src/lib/applications').Application;

/**
 * Component tests for the create-installation page (invitation-first): the
 * customer picker behavior, the invitation creation path (no deployment), the
 * optional recommended region, and the ?test=true direct-creation path.
 * Rendered with react-dom/client + act inside jsdom, matching
 * dialog-loading.test.tsx and multi-action-loading.test.tsx — a Radix
 * Popover portal and real dispatched clicks need a live DOM.
 */

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Acme App',
    githubInstallationId: 'gh-1',
    repoFullName: 'acme/app',
    repoUrl: 'https://github.com/acme/app',
    defaultBranch: 'main',
    containerPort: 3000,
    healthPath: '/health',
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: false,
    storageRequired: false,
    redisRequired: false,
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    compatibilityReason: null,
    detectedMetadata: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cus-1',
    organizationId: 'org-1',
    name: 'Acme Corp',
    email: 'acme@example.com',
    company: null,
    externalReference: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const INVITATION = {
  id: '11111111-1111-1111-1111-111111111111',
  token: 't'.repeat(64),
  expiresAt: '2026-10-24T00:00:00.000Z',
  recommendedRegion: null,
};

const cleanups: Array<() => void> = [];

async function renderPage(query = ''): Promise<HTMLElement> {
  searchParamsMocks.query = query;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<NewDeploymentPage />);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.type === 'submit',
  ) as HTMLButtonElement;
}

function customerPickerTrigger(): HTMLButtonElement {
  return document.getElementById('customer-picker-trigger') as HTMLButtonElement;
}

/** Opens the picker and clicks the option whose text contains `label`. */
async function selectCustomerOption(label: string): Promise<void> {
  await act(async () => {
    click(customerPickerTrigger());
  });
  const option = Array.from(document.querySelectorAll('[data-slot="command-item"]')).find((item) =>
    (item.textContent ?? '').includes(label),
  ) as HTMLElement;
  await act(async () => {
    click(option);
  });
}

/** Types into the new-customer inputs (uncontrolled native inputs). */
async function fillNewCustomer(container: HTMLElement): Promise<void> {
  const nameInput = container.querySelector('#customerName') as HTMLInputElement;
  const emailInput = container.querySelector('#customerEmail') as HTMLInputElement;
  await act(async () => {
    nameInput.value = 'New Co';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    emailInput.value = 'new@example.com';
    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.fetchApplications.mockReset().mockResolvedValue([application()]);
  mocks.fetchCustomers.mockReset().mockResolvedValue([]);
  mocks.createCustomerRecord.mockReset();
  mocks.createDeploymentRecord.mockReset();
  mocks.createInvitation.mockReset().mockResolvedValue(INVITATION);
  mocks.fetchRegions.mockReset().mockResolvedValue([{ value: 'us-east-1', label: 'US East (N. Virginia)' }]);
  mocks.fetchApplicationPreflight.mockReset().mockRejectedValue(new Error('no preflight in this test'));
});

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
});

describe('create-installation page (invitation-first)', () => {
  it('creates a customer then an invitation — and no deployment', async () => {
    mocks.fetchCustomers.mockResolvedValue([customer({ id: 'cus-1', name: 'Acme Corp' })]);
    mocks.createCustomerRecord.mockResolvedValue({
      id: 'cus-new',
      organizationId: 'org-1',
      name: 'New Co',
      email: 'new@example.com',
      company: null,
      externalReference: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const container = await renderPage();
    expect(customerPickerTrigger().textContent).toBe('Create new customer');
    expect(container.textContent).toContain('Create installation');

    await fillNewCustomer(container);

    await act(async () => {
      submitButton(container).click();
    });

    expect(mocks.createCustomerRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createCustomerRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Co', email: 'new@example.com' }),
    );
    expect(mocks.createInvitation).toHaveBeenCalledTimes(1);
    // No recommendation chosen: the body omits recommendedRegion entirely.
    expect(mocks.createInvitation).toHaveBeenCalledWith({
      customerId: 'cus-new',
      applicationId: 'app-1',
    });
    expect(mocks.createDeploymentRecord).not.toHaveBeenCalled();

    // The success card reveals ONE URL that carries the one-time token.
    expect(container.textContent).toContain('Installation invitation created');
    expect(container.textContent).toContain(`#${INVITATION.token}`);
    expect(container.textContent).toContain(
      'a deployment is created only after their confirmation',
    );
  });

  it('selecting an existing customer skips customer creation and invites that customer', async () => {
    mocks.fetchCustomers.mockResolvedValue([
      customer({ id: 'cus-1', name: 'Acme Corp', email: 'acme@example.com' }),
    ]);

    const container = await renderPage();
    expect(container.querySelector('#customerName')).not.toBeNull();

    await selectCustomerOption('Acme Corp');

    expect(customerPickerTrigger().textContent).toBe('Acme Corp');
    expect(container.querySelector('#customerName')).toBeNull();
    expect(container.querySelector('#customerEmail')).toBeNull();

    await act(async () => {
      submitButton(container).click();
    });

    expect(mocks.createCustomerRecord).not.toHaveBeenCalled();
    expect(mocks.createInvitation).toHaveBeenCalledTimes(1);
    expect(mocks.createInvitation).toHaveBeenCalledWith({
      customerId: 'cus-1',
      applicationId: 'app-1',
    });
    expect(mocks.createDeploymentRecord).not.toHaveBeenCalled();
  });

  it('sends the optional recommended region only when the vendor chose one', async () => {
    mocks.fetchCustomers.mockResolvedValue([customer({ id: 'cus-1', name: 'Acme Corp' })]);

    const container = await renderPage();
    await selectCustomerOption('Acme Corp');

    const regionSelect = container.querySelector('#region') as HTMLSelectElement;
    expect(regionSelect).not.toBeNull();
    // The default is "No recommendation", not the first region.
    expect(regionSelect.value).toBe('');
    expect(Array.from(regionSelect.options).map((option) => option.value)).toEqual([
      '',
      'us-east-1',
    ]);
    expect(container.textContent).toContain(
      'Optional. Your customer makes the final region choice before deployment.',
    );

    await act(async () => {
      regionSelect.value = 'us-east-1';
      regionSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      submitButton(container).click();
    });

    expect(mocks.createInvitation).toHaveBeenCalledWith({
      customerId: 'cus-1',
      applicationId: 'app-1',
      recommendedRegion: 'us-east-1',
    });
  });

  it('preselects the customer named by ?customerId= and hides the name/email inputs', async () => {
    mocks.fetchCustomers.mockResolvedValue([
      customer({ id: 'cus-1', name: 'Acme Corp' }),
      customer({ id: 'cus-2', name: 'Contoso Retail' }),
    ]);

    const container = await renderPage('customerId=cus-2');

    expect(customerPickerTrigger().textContent).toBe('Contoso Retail');
    expect(container.querySelector('#customerName')).toBeNull();
  });

  it('falls back to "Create new customer" for an unknown ?customerId=', async () => {
    mocks.fetchCustomers.mockResolvedValue([customer({ id: 'cus-1', name: 'Acme Corp' })]);

    const container = await renderPage('customerId=does-not-exist');

    expect(customerPickerTrigger().textContent).toBe('Create new customer');
    expect(container.querySelector('#customerName')).not.toBeNull();
  });

  it('still allows the new-customer path when the customers request fails', async () => {
    mocks.fetchCustomers.mockRejectedValue(new Error('offline'));
    mocks.createCustomerRecord.mockResolvedValue({
      id: 'cus-new',
      organizationId: 'org-1',
      name: 'New Co',
      email: 'new@example.com',
      company: null,
      externalReference: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const container = await renderPage();

    expect(container.textContent).toContain("We couldn't load your customers.");
    expect(customerPickerTrigger().textContent).toBe('Create new customer');

    await fillNewCustomer(container);
    await act(async () => {
      submitButton(container).click();
    });

    expect(mocks.createCustomerRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('ignores a duplicate submit fired while the first is still pending', async () => {
    mocks.fetchCustomers.mockResolvedValue([]);
    mocks.createCustomerRecord.mockResolvedValue({
      id: 'cus-new',
      organizationId: 'org-1',
      name: 'New Co',
      email: 'new@example.com',
      company: null,
      externalReference: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    let resolveInvitation!: (value: unknown) => void;
    mocks.createInvitation.mockReturnValue(
      new Promise((resolve) => {
        resolveInvitation = resolve;
      }),
    );

    const container = await renderPage();
    await fillNewCustomer(container);

    const submit = submitButton(container);
    await act(async () => {
      submit.click();
    });
    // A second click while the button is disabled/pending must not fire
    // another submit.
    submit.click();

    await act(async () => {
      resolveInvitation(INVITATION);
    });

    expect(mocks.createCustomerRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('?test=true still creates the deployment directly with the vendor-chosen region', async () => {
    mocks.fetchCustomers.mockResolvedValue([customer({ id: 'cus-1', name: 'Acme Corp' })]);
    mocks.createDeploymentRecord.mockResolvedValue({
      id: 'dep-1',
      customerId: 'cus-1',
      applicationId: 'app-1',
      organizationId: 'org-1',
      region: 'us-east-1',
      state: 'NOT_INSTALLED',
      installLinkId: 'link-1',
      deploymentType: 'TEST',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const container = await renderPage('test=true');
    expect(container.textContent).toContain('Create Test Deployment');
    await selectCustomerOption('Acme Corp');

    // The region is required and defaults to the first available option.
    const regionSelect = container.querySelector('#region') as HTMLSelectElement;
    expect(regionSelect.value).toBe('us-east-1');

    await act(async () => {
      submitButton(container).click();
    });

    expect(mocks.createDeploymentRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createDeploymentRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus-1',
        applicationId: 'app-1',
        region: 'us-east-1',
        deploymentType: 'TEST',
      }),
    );
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Deployment created');
  });
});

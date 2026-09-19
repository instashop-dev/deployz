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
  fetchRegions: vi.fn(),
  fetchApplicationPreflight: vi.fn(),
}));

vi.mock('../src/lib/applications', () => ({
  fetchApplications: mocks.fetchApplications,
}));

vi.mock('../src/lib/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/customers')>();
  return { ...actual, fetchCustomers: mocks.fetchCustomers };
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

// Kept apart from real @paddle/paddle-js — production billing status is
// irrelevant to the customer-picker behavior under test.
vi.mock('../src/lib/billing-checkout', () => ({
  fetchBillingConfig: vi.fn(),
  fetchSubscriptionStatus: vi.fn().mockResolvedValue('ACTIVE'),
  fetchProductionDeploymentCounts: vi.fn().mockResolvedValue({ active: 0, included: 0, billable: 0 }),
  createCheckoutIntent: vi.fn(),
  openSubscriptionCheckout: vi.fn(),
}));

const NewDeploymentPage = (await import('../src/app/dashboard/deployments/new/page')).default;
type Customer = import('../src/lib/customers').Customer;
type Application = import('../src/lib/applications').Application;

/**
 * Component tests for the create-deployment page's customer picker (this
 * change): default new-customer path, selecting an existing customer,
 * ?customerId= preselection (found and unknown), a failed customer fetch,
 * and a duplicate submit. Rendered with react-dom/client + act inside jsdom,
 * matching dialog-loading.test.tsx and multi-action-loading.test.tsx — a
 * Radix Popover portal and real dispatched clicks need a live DOM.
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

beforeEach(() => {
  mocks.fetchApplications.mockReset().mockResolvedValue([application()]);
  mocks.fetchCustomers.mockReset().mockResolvedValue([]);
  mocks.createCustomerRecord.mockReset();
  mocks.createDeploymentRecord.mockReset();
  mocks.fetchRegions.mockReset().mockResolvedValue([{ value: 'us-east-1', label: 'US East (N. Virginia)' }]);
  mocks.fetchApplicationPreflight.mockReset().mockRejectedValue(new Error('no preflight in this test'));
});

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
});

describe('CustomerPicker on the create-deployment page', () => {
  it('defaults to "Create new customer" and creates a customer then a deployment', async () => {
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
    mocks.createDeploymentRecord.mockResolvedValue({
      id: 'dep-1',
      customerId: 'cus-new',
      applicationId: 'app-1',
      organizationId: 'org-1',
      region: 'us-east-1',
      state: 'NOT_INSTALLED',
      installLinkId: 'link-1',
      deploymentType: 'PRODUCTION',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const container = await renderPage();
    expect(customerPickerTrigger().textContent).toBe('Create new customer');

    const nameInput = container.querySelector('#customerName') as HTMLInputElement;
    const emailInput = container.querySelector('#customerEmail') as HTMLInputElement;
    expect(nameInput).not.toBeNull();

    await act(async () => {
      nameInput.value = 'New Co';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.value = 'new@example.com';
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      submitButton(container).click();
    });

    expect(mocks.createCustomerRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createCustomerRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Co', email: 'new@example.com' }),
    );
    expect(mocks.createDeploymentRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createDeploymentRecord).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus-new', applicationId: 'app-1' }),
    );
  });

  it('selecting an existing customer hides the new-customer inputs and calls only createDeploymentRecord', async () => {
    mocks.fetchCustomers.mockResolvedValue([
      customer({ id: 'cus-1', name: 'Acme Corp', email: 'acme@example.com' }),
    ]);
    mocks.createDeploymentRecord.mockResolvedValue({
      id: 'dep-1',
      customerId: 'cus-1',
      applicationId: 'app-1',
      organizationId: 'org-1',
      region: 'us-east-1',
      state: 'NOT_INSTALLED',
      installLinkId: 'link-1',
      deploymentType: 'PRODUCTION',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

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
    expect(mocks.createDeploymentRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createDeploymentRecord).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus-1' }),
    );
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
    mocks.createDeploymentRecord.mockResolvedValue({
      id: 'dep-1',
      customerId: 'cus-new',
      applicationId: 'app-1',
      organizationId: 'org-1',
      region: 'us-east-1',
      state: 'NOT_INSTALLED',
      installLinkId: 'link-1',
      deploymentType: 'PRODUCTION',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const container = await renderPage();

    expect(container.textContent).toContain("We couldn't load your customers.");
    expect(customerPickerTrigger().textContent).toBe('Create new customer');

    const nameInput = container.querySelector('#customerName') as HTMLInputElement;
    const emailInput = container.querySelector('#customerEmail') as HTMLInputElement;
    await act(async () => {
      nameInput.value = 'New Co';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.value = 'new@example.com';
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      submitButton(container).click();
    });

    expect(mocks.createCustomerRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createDeploymentRecord).toHaveBeenCalledTimes(1);
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
    let resolveDeployment!: (value: unknown) => void;
    mocks.createDeploymentRecord.mockReturnValue(
      new Promise((resolve) => {
        resolveDeployment = resolve;
      }),
    );

    const container = await renderPage();
    const nameInput = container.querySelector('#customerName') as HTMLInputElement;
    const emailInput = container.querySelector('#customerEmail') as HTMLInputElement;
    await act(async () => {
      nameInput.value = 'New Co';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.value = 'new@example.com';
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submit = submitButton(container);
    await act(async () => {
      submit.click();
    });
    // A second click while the button is disabled/pending must not fire
    // another submit.
    submit.click();

    await act(async () => {
      resolveDeployment({
        id: 'dep-1',
        customerId: 'cus-new',
        applicationId: 'app-1',
        organizationId: 'org-1',
        region: 'us-east-1',
        state: 'NOT_INSTALLED',
        installLinkId: 'link-1',
        deploymentType: 'PRODUCTION',
        createdAt: '2026-08-01T00:00:00.000Z',
      });
    });

    expect(mocks.createCustomerRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createDeploymentRecord).toHaveBeenCalledTimes(1);
  });
});

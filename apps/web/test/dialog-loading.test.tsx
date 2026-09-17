// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const customerMocks = vi.hoisted(() => ({
  deleteCustomer: vi.fn(),
}));
vi.mock('../src/lib/customers', () => ({
  deleteCustomer: customerMocks.deleteCustomer,
}));

const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMocks,
}));

const installMocks = vi.hoisted(() => ({
  retryInstallAttempt: vi.fn(),
}));
vi.mock('../src/lib/install-data', () => ({
  retryInstallAttempt: installMocks.retryInstallAttempt,
  InstallRetryError: class InstallRetryError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string) {
      super(`Install retry failed (${status})`);
      this.status = status;
      this.code = code;
    }
  },
}));
vi.mock('../src/lib/deploy-link-flow', () => ({
  retryDeployLinkAttempt: vi.fn(),
}));

const { DeleteCustomerDialog } = await import('../src/components/delete-customer-dialog');
const { InstallRetryButton } = await import('../src/components/install-retry-button');

/**
 * Dialog/control loading-state tests (standardized loading system, Group 2).
 * Rendered with react-dom/client + act inside jsdom, matching
 * loading-primitives.test.tsx: a Radix portal and real dispatched clicks need
 * a live DOM, not renderToString.
 */

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cleanups: Array<() => void> = [];

function render(node: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return { container, root };
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
  customerMocks.deleteCustomer.mockReset();
  installMocks.retryInstallAttempt.mockReset();
  routerMocks.refresh.mockReset();
});

const customer = {
  id: 'cust-1',
  organizationId: 'org-1',
  name: 'Acme',
  email: 'acme@example.com',
  company: null,
  externalReference: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('DeleteCustomerDialog loading', () => {
  it('shows loading feedback while pending, ignores a second click, and recovers on rejection', async () => {
    const def = deferred<void>();
    customerMocks.deleteCustomer.mockReturnValue(def.promise);
    const onDeleted = vi.fn();

    render(
      <DeleteCustomerDialog customer={customer} open onOpenChange={() => undefined} onDeleted={onDeleted} />,
    );

    const action = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLButtonElement;
    expect(action.textContent).toBe('Remove customer');
    expect(action.disabled).toBe(false);

    await act(async () => {
      click(action);
    });

    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.textContent).toBe('Removing customer…');
    expect(action.querySelector('[data-slot="spinner"]')).not.toBeNull();

    // A second click while disabled must not dispatch another click handler.
    click(action);
    expect(customerMocks.deleteCustomer).toHaveBeenCalledTimes(1);

    await act(async () => {
      def.reject(new Error('network down'));
      await def.promise.catch(() => undefined);
    });

    expect(action.disabled).toBe(false);
    expect(action.hasAttribute('aria-busy')).toBe(false);
    expect(action.textContent).toBe('Remove customer');
    expect(onDeleted).not.toHaveBeenCalled();
    const error = document.querySelector('[data-testid="delete-customer-error"]');
    expect(error?.textContent).toBe('Something went wrong. Try again in a moment.');
  });
});

describe('InstallRetryButton loading', () => {
  it('enters loading immediately on click and restores after rejection', async () => {
    const def = deferred<{ quickCreateUrl: string | null }>();
    installMocks.retryInstallAttempt.mockReturnValue(def.promise);

    const { container } = render(<InstallRetryButton installLinkId="link-1" />);
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('Retry deployment');

    await act(async () => {
      click(button);
    });

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Retrying deployment…');
    expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(routerMocks.refresh).not.toHaveBeenCalled();

    await act(async () => {
      def.reject(new Error('offline'));
      await def.promise.catch(() => undefined);
    });

    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.textContent).toBe('Retry deployment');
    expect(routerMocks.refresh).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "We couldn't start the retry. Try again in a moment.",
    );
  });
});

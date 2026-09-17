// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// react-dom/client's act() checks this flag before running; without it, every
// act() call warns even though the assertions below pass.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMocks }));

const routerMocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMocks }));

const apiMocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('../src/lib/api-client', () => ({
  apiRequest: apiMocks.apiRequest,
  errorMessage: () => 'Something went wrong. Try again in a moment.',
}));

const authMocks = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('../src/lib/auth-client', () => ({ authClient: { signOut: authMocks.signOut } }));

// The dropdown menu itself (open/close, positioning, focus trapping) is
// Radix's own behavior and is exercised elsewhere; mocked here to a plain
// always-rendered structure so this test can reach the Sign out item without
// simulating Radix's pointer-driven open sequence in jsdom.
vi.mock('../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, ...props }: Record<string, unknown> & { children: React.ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    asChild: _asChild,
    ...props
  }: Record<string, unknown> & {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    asChild?: boolean;
  }) => (
    <div
      role="menuitem"
      data-disabled={disabled || undefined}
      {...props}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
      }}
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

const { AcceptInvitationActions } = await import('../src/components/accept-invitation-actions');
const { UserMenu } = await import('../src/components/user-menu');

/**
 * Multi-action loading-state tests (standardized loading system, Group 3):
 * per-action pending locks that disable the sibling action without spinning
 * it, and error-handling additions to sign-out. Rendered with react-dom/client
 * + act inside jsdom, matching loading-primitives.test.tsx and
 * dialog-loading.test.tsx.
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
  apiMocks.apiRequest.mockReset();
  authMocks.signOut.mockReset();
  routerMocks.push.mockReset();
  routerMocks.refresh.mockReset();
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
});

describe('AcceptInvitationActions loading', () => {
  it('locks the selected action only, ignores a duplicate click, and restores both on rejection', async () => {
    const def = deferred<void>();
    apiMocks.apiRequest.mockReturnValue(def.promise);

    const { container } = render(<AcceptInvitationActions id="invite-1" />);
    const accept = container.querySelector('[data-testid="invitation-accept"]') as HTMLButtonElement;
    const decline = container.querySelector('[data-testid="invitation-decline"]') as HTMLButtonElement;

    expect(accept.textContent).toBe('Accept');
    expect(decline.textContent).toBe('Decline');

    await act(async () => {
      click(accept);
    });

    expect(accept.disabled).toBe(true);
    expect(accept.getAttribute('aria-busy')).toBe('true');
    expect(accept.textContent).toBe('Accepting invitation…');
    expect(accept.querySelector('[data-slot="spinner"]')).not.toBeNull();

    // The sibling action is locked out, but not shown as busy itself.
    expect(decline.disabled).toBe(true);
    expect(decline.hasAttribute('aria-busy')).toBe(false);
    expect(decline.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(decline.textContent).toBe('Decline');

    // A duplicate click on the (disabled) Accept button must not re-invoke it.
    click(accept);
    expect(apiMocks.apiRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      def.reject(new Error('network down'));
      await def.promise.catch(() => undefined);
    });

    expect(accept.disabled).toBe(false);
    expect(accept.hasAttribute('aria-busy')).toBe(false);
    expect(accept.textContent).toBe('Accept');
    expect(decline.disabled).toBe(false);
    expect(decline.hasAttribute('aria-busy')).toBe(false);
    expect(decline.textContent).toBe('Decline');
  });
});

describe('sign-out failure handling', () => {
  it('clears the pending state and shows a toast when signOut rejects', async () => {
    const def = deferred<void>();
    authMocks.signOut.mockReturnValue(def.promise);

    const { container } = render(<UserMenu name="Ada Lovelace" email="ada@example.com" />);
    const item = Array.from(container.querySelectorAll('[role="menuitem"]')).find((el) =>
      (el.textContent ?? '').includes('Sign out'),
    ) as HTMLElement;
    expect(item.textContent).toBe('Sign out');

    await act(async () => {
      click(item);
    });

    expect(authMocks.signOut).toHaveBeenCalledTimes(1);
    expect(item.getAttribute('data-disabled')).not.toBeNull();
    expect(item.getAttribute('aria-busy')).toBe('true');
    expect(item.textContent).toBe('Signing out…');
    expect(item.querySelector('[data-slot="spinner"]')).not.toBeNull();

    // A duplicate click while pending must not re-invoke signOut.
    click(item);
    expect(authMocks.signOut).toHaveBeenCalledTimes(1);

    await act(async () => {
      def.reject(new Error('network down'));
      await def.promise.catch(() => undefined);
    });

    expect(toastMocks.error).toHaveBeenCalledWith("We couldn't sign you out. Try again in a moment.");
    expect(item.hasAttribute('data-disabled')).toBe(false);
    expect(item.hasAttribute('aria-busy')).toBe(false);
    expect(item.textContent).toBe('Sign out');
    expect(routerMocks.push).not.toHaveBeenCalled();
  });
});

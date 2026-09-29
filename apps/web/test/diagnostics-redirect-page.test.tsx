// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The old /diagnostics route is now a deep link (ux-guidelines §2):
// diagnostics folded into the deployment page, so this route only redirects
// to the right section there.

const navigationMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  id: 'dep-1',
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: navigationMocks.id }),
  useRouter: () => ({ replace: navigationMocks.replace }),
}));

const DiagnosticsRedirectPage = (await import('../src/app/dashboard/deployments/[id]/diagnostics/page'))
  .default;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  navigationMocks.replace.mockClear();
  navigationMocks.id = 'dep-1';
  window.location.hash = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DiagnosticsRedirectPage', () => {
  it('redirects to the infrastructure check section by default', () => {
    act(() => {
      root.render(<DiagnosticsRedirectPage />);
    });
    expect(navigationMocks.replace).toHaveBeenCalledWith(
      '/dashboard/deployments/dep-1#infrastructure-check',
    );
  });

  it('maps a #startup-evidence link to the recovery panel', () => {
    window.location.hash = '#startup-evidence';
    act(() => {
      root.render(<DiagnosticsRedirectPage />);
    });
    expect(navigationMocks.replace).toHaveBeenCalledWith('/dashboard/deployments/dep-1#recovery');
  });
});

import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AppSidebar } from '../src/components/app-sidebar';
import { SidebarProvider } from '../src/components/ui/sidebar';

// The dashboard account menu lives in the sidebar footer: the trigger shows
// the user's name. The dropdown contents and sign-out flow stay behavioral
// and are covered by the e2e specs.

const mocks = vi.hoisted(() => ({
  pathname: '/dashboard',
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }),
}));

function renderSidebar(): Document {
  return new JSDOM(
    renderToString(
      <SidebarProvider>
        <AppSidebar
          user={{ name: 'E2E User', email: 'e2e@example.com' }}
          organizations={[]}
          activeOrganizationId={null}
        />
      </SidebarProvider>,
    ),
  ).window.document;
}

describe('AppSidebar footer account menu', () => {
  it('renders the account trigger with the user name inside the sidebar footer', () => {
    const doc = renderSidebar();

    const footer = doc.querySelector('[data-sidebar="footer"]');
    expect(footer).not.toBeNull();
    const trigger = footer?.querySelector('[data-testid="user-menu-trigger"]');
    expect(trigger?.textContent).toContain('E2E User');
  });

  it('hides the brand wordmark in the collapsed icon rail', () => {
    const doc = renderSidebar();

    const brand = doc.querySelector('[data-sidebar="header"] a[href="/dashboard"]');
    expect(brand?.className).toContain('group-data-[collapsible=icon]:hidden');
  });
});

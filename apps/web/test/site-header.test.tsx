import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { sectionLabel, SiteHeader } from '../src/components/site-header';
import { SidebarProvider } from '../src/components/ui/sidebar';

// The top bar names the section only where that adds hierarchy, shows the
// wordmark for mobile, and carries no user identity — the account menu lives
// in the sidebar footer.

const mocks = vi.hoisted(() => ({ pathname: '/dashboard' }));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
}));

function renderHeader(): Document {
  return new JSDOM(
    renderToString(
      <SidebarProvider>
        <SiteHeader />
      </SidebarProvider>,
    ),
  ).window.document;
}

describe('sectionLabel', () => {
  it('suppresses the label on top-level index routes', () => {
    expect(sectionLabel('/dashboard')).toBeNull();
    expect(sectionLabel('/dashboard/applications')).toBeNull();
    expect(sectionLabel('/dashboard/customers')).toBeNull();
    expect(sectionLabel('/dashboard/deployments')).toBeNull();
    expect(sectionLabel('/dashboard/settings')).toBeNull();
  });

  it('keeps the parent label on nested routes', () => {
    expect(sectionLabel('/dashboard/applications/app-1')).toBe('Applications');
    expect(sectionLabel('/dashboard/applications/new')).toBe('Add application');
    expect(sectionLabel('/dashboard/deployments/dep-1')).toBe('Deployments');
    expect(sectionLabel('/dashboard/deployments/new')).toBe('Deploy customer');
    expect(sectionLabel('/dashboard/customers/cust-1')).toBe('Customers');
    expect(sectionLabel('/dashboard/settings/profile')).toBe('Profile');
    expect(sectionLabel('/dashboard/settings/billing')).toBe('Billing');
    expect(sectionLabel('/dashboard/settings/members')).toBe('Team');
  });
});

describe('SiteHeader', () => {
  it('renders no section label and no user identity on index routes', () => {
    mocks.pathname = '/dashboard/applications';
    const doc = renderHeader();

    expect(doc.body.textContent).not.toContain('Applications');
    expect(doc.querySelector('[data-testid="user-menu-trigger"]')).toBeNull();
    expect(doc.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(doc.body.textContent).not.toContain('Sign out');
  });

  it('keeps the section label on a nested route', () => {
    mocks.pathname = '/dashboard/deployments/dep-1';
    const doc = renderHeader();

    expect(doc.body.textContent).toContain('Deployments');
  });

  it('shows the Deployz wordmark next to the trigger', () => {
    mocks.pathname = '/dashboard';
    const doc = renderHeader();

    const wordmark = doc.querySelector('a[href="/dashboard"]');
    expect(wordmark?.textContent).toBe('Deployz');
    expect(doc.querySelector('[data-sidebar="trigger"]')).not.toBeNull();
  });
});

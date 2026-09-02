import type { Locator, Page } from '@playwright/test';

// Team Admin console coverage (docs/admin/team-admin.md). Mirrors
// e2e/organization.spec.ts's house conventions: a fresh account per journey,
// fillControlled for React-controlled inputs, data-testid-driven assertions,
// and direct page.request calls (reusing the browser's session cookie) for
// API-level checks. Imports `test`/`expect` from the simulation fixtures
// (like e2e/scenario-install.spec.ts) so the failed-deployment journey can
// use `deployzBrowserInstall` — every other test here ignores that fixture.
import { API_URL, expect, test } from './simulation/fixtures.js';

// A mutation followed by router.refresh()/a client refetch can comfortably
// exceed the 5s default expect window on a busy dev server — see
// organization.spec.ts's own REFRESH_TIMEOUT.
const REFRESH_TIMEOUT = 15_000;

// React-controlled inputs need a retry-until-it-sticks fill, same as every
// other browser spec in this house (organization.spec.ts's fillControlled).
async function fillControlled(locator: Locator, value: string): Promise<void> {
  await expect(async () => {
    await locator.fill(value);
    await expect(locator).toHaveValue(value);
  }).toPass({ timeout: 15_000 });
}

function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

// TEAM_ADMIN_EMAILS is set to `*@admin-e2e.deployz.test` in playwright.config.ts's
// API webServer env — any signed-up account under this domain is a team admin.
function uniqueAdminEmail(prefix = 'admin'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@admin-e2e.deployz.test`;
}

async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(crypto.randomUUID());
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function currentOrg(page: Page): Promise<{ id: string; name: string }> {
  const response = await page.request.get(`${API_URL}/api/organization`);
  expect(response.ok()).toBeTruthy();
  const org = (await response.json()) as { id: string; name: string };
  return { id: org.id, name: org.name };
}

test.describe('admin authorization', () => {
  // A normal vendor never reaches an admin page, and the admin API rejects
  // them independently of navigation — matching docs/admin/team-admin.md's
  // "navigation visibility is never the security boundary".
  test('a normal vendor is redirected away from /admin and the API rejects them', async ({ page }) => {
    await signUp(page, 'Vendor User', uniqueEmail('vendor-auth'));

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/(dashboard|sign-in)/);
    await expect(page.getByTestId('admin-overview-counts')).toHaveCount(0);

    const response = await page.request.get(`${API_URL}/api/admin/overview`);
    expect(response.status()).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_TEAM_ADMIN');
  });

  // An account whose email matches TEAM_ADMIN_EMAILS reaches /admin and the
  // overview renders real data.
  test('an admin-email account reaches /admin and the overview renders', async ({ page }) => {
    await signUp(page, 'Admin User', uniqueAdminEmail('boss'));

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId('admin-overview-counts')).toBeVisible();

    const response = await page.request.get(`${API_URL}/api/admin/overview`);
    expect(response.ok()).toBeTruthy();
  });
});

test.describe('admin search and vendor detail', () => {
  // Creates a vendor with a distinctive organization name (so search returns
  // exactly one match regardless of what else is in the dev DB), then finds
  // it through the admin's global search and confirms the vendor 360° page
  // shows the owner's email.
  test('global search finds a vendor and the detail page shows its owner', async ({ page, browser }) => {
    const vendorEmail = uniqueEmail('vendor-search');
    const orgName = `Search Target Org ${crypto.randomUUID().slice(0, 8)}`;

    await signUp(page, 'Search Vendor Owner', vendorEmail);
    await page.goto('/organizations/new');
    await fillControlled(page.getByTestId('create-organization-name'), orgName);
    await page.getByTestId('create-organization-submit').click();
    await page.waitForURL('/dashboard');
    await expect(page.getByTestId('org-name')).toHaveText(orgName);

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signUp(adminPage, 'Admin User', uniqueAdminEmail('search-admin'));

    await adminPage.goto('/admin');
    await fillControlled(adminPage.getByTestId('admin-search-input'), orgName);
    await adminPage.getByTestId('admin-search-input').press('Enter');
    await adminPage.waitForURL(/\/admin\/search\?q=/);

    await expect(adminPage.getByTestId('admin-search-results')).toBeVisible();
    const vendorLink = adminPage.getByRole('link', { name: orgName });
    await expect(vendorLink).toBeVisible();
    await vendorLink.click();

    await adminPage.waitForURL(/\/admin\/vendors\/[^/]+$/);
    await expect(adminPage.getByRole('heading', { name: orgName })).toBeVisible();
    await expect(adminPage.getByText(vendorEmail)).toBeVisible();

    await adminContext.close();
  });
});

test.describe('view as vendor', () => {
  // Enters support mode from the vendor detail page, confirms the banner and
  // vendor context render on /dashboard, confirms a write is blocked
  // (403 SUPPORT_MODE_READ_ONLY), exits, confirms the admin is back in their
  // own context, then checks both audit events landed.
  test('entering and exiting support mode is audited and enforces read-only', async ({ page, browser }) => {
    const vendorContext = await browser.newContext();
    const vendorPage = await vendorContext.newPage();
    await signUp(vendorPage, 'Support Target Owner', uniqueEmail('vendor-support'));
    const vendorOrg = await currentOrg(vendorPage);
    await vendorContext.close();

    const adminEmail = uniqueAdminEmail('support-admin');
    await signUp(page, 'Support Admin', adminEmail);
    const adminOrg = await currentOrg(page);

    await page.goto(`/admin/vendors/${vendorOrg.id}`);
    await expect(page.getByRole('heading', { name: vendorOrg.name })).toBeVisible();
    await page.getByTestId('view-as-vendor').click();

    await page.waitForURL('/dashboard');
    await expect(page.getByTestId('support-mode-banner')).toBeVisible();
    await expect(page.getByTestId('support-mode-banner')).toContainText(vendorOrg.name);
    // The admin isn't a real member of the vendor's org (support mode is a
    // synthetic role, not a membership row), so the sidebar's org-switcher —
    // which only lists real memberships — can't show the vendor's name.
    // /api/organization is what request.organization actually resolves to
    // server-side, so it's the authoritative proof the vendor's context (not
    // the admin's own) is active.
    const activeOrg = await currentOrg(page);
    expect(activeOrg.id).toBe(vendorOrg.id);

    // Support mode is read-only: any non-GET vendor API call is rejected,
    // even though the admin's session is now scoped to the vendor's org.
    const blocked = await page.request.post(`${API_URL}/api/customers`, {
      data: { name: 'Should not be created', email: uniqueEmail('blocked-customer') },
    });
    expect(blocked.status()).toBe(403);
    const blockedBody = (await blocked.json()) as { error: { code: string } };
    expect(blockedBody.error.code).toBe('SUPPORT_MODE_READ_ONLY');

    await page.getByTestId('support-banner-exit').click();
    await page.waitForURL('/admin');

    await page.goto('/dashboard');
    await expect(page.getByTestId('support-mode-banner')).toHaveCount(0);
    const restoredOrg = await currentOrg(page);
    expect(restoredOrg.id).toBe(adminOrg.id);

    await page.goto('/admin/audit-log');
    await fillControlled(page.getByTestId('audit-actor-filter'), adminEmail);
    await expect(page.getByTestId('admin-audit-log-table')).toContainText('Started viewing as vendor', {
      timeout: REFRESH_TIMEOUT,
    });
    await expect(page.getByTestId('admin-audit-log-table')).toContainText('Stopped viewing as vendor');
  });
});

test.describe('failed deployment diagnosis and recovery', () => {
  test.use({ deployzScenario: 'cloudformation-rollback' });

  // Seeds a vendor + deployment through the real relay pipeline
  // (deployzBrowserInstall, see e2e/simulation/fixtures.ts) against the
  // cloudformation-rollback scenario, which ends in a terminal FAILED state
  // (e2e/scenario-install.spec.ts proves the API-level shape). A SEPARATE
  // admin browser session then diagnoses and retries it — deterministic,
  // API-anchored assertions throughout, per the task brief's flakiness note.
  test('admin diagnoses a failed install and requests a retry', async ({ deployzBrowserInstall, browser }) => {
    test.setTimeout(60_000);
    const { deploymentId, api } = deployzBrowserInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 20_000,
        message: 'waiting for the seeded deployment to reach FAILED',
      })
      .toBe('FAILED');

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const adminEmail = uniqueAdminEmail('recovery-admin');
    await signUp(adminPage, 'Recovery Admin', adminEmail);

    // The failure is visible in the pre-filtered deployments list.
    await adminPage.goto('/admin/deployments?filter=failed');
    await expect(adminPage.locator(`a[href="/admin/deployments/${deploymentId}"]`)).toBeVisible({
      timeout: REFRESH_TIMEOUT,
    });

    // The command-center detail page: failed state, progress steps, and the
    // raw AWS status kept behind "Technical details" territory.
    await adminPage.goto(`/admin/deployments/${deploymentId}`);
    await expect(adminPage.getByText('Failed', { exact: true }).first()).toBeVisible();
    const awsStatusLine = adminPage.getByText('AWS status:');
    await expect(awsStatusLine).toBeVisible();
    await expect(awsStatusLine.locator('code')).toHaveText('ROLLBACK_COMPLETE');

    const retryButton = adminPage.getByTestId('admin-retry-install');
    await expect(retryButton).toBeEnabled();
    await retryButton.click();

    const panel = adminPage.getByTestId('admin-retry-install-panel');
    await expect(panel).toBeVisible();
    const retryResponse = adminPage.waitForResponse(
      (response) => response.url().includes('/retry-install') && response.request().method() === 'POST',
    );
    await panel.getByRole('button', { name: 'Retry install' }).click();
    const response = await retryResponse;
    expect(response.ok()).toBeTruthy();
    await expect(panel).toBeHidden();

    await adminPage.goto('/admin/audit-log');
    await fillControlled(adminPage.getByTestId('audit-actor-filter'), adminEmail);
    await expect(adminPage.getByTestId('admin-audit-log-table')).toContainText('Retried install', {
      timeout: REFRESH_TIMEOUT,
    });

    await adminContext.close();
  });
});

import { expect, test, type Page } from '@playwright/test';

// §42 onboarding flow + §19 readiness page, against the REAL API. The API
// runs with GITHUB_FIXTURE_MODE (see playwright.config.ts), so the
// Applications page lists the fixture org/repos; choosing a repository now
// creates a real Application (POST /api/applications) and triggers analysis
// (POST /api/applications/:id/analyse) before navigating to it. A real
// analyser is wired up and completes near-instantly in fixture mode, so the
// readiness page for a freshly-created application renders the real §19
// COMPLETE verdict, never a fabricated one.

// Raw AWS service terms that must NOT appear in rendered top-level copy (§65).
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('choosing a repository creates a real application and opens its readiness page (§42 step 2)', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  await page.getByRole('button', { name: 'Select' }).first().click();
  // The Application row is now real — the URL carries a UUID, not a
  // fixture-repo-* id.
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // The setup lifecycle lives on the Overview tab.
  await expect(page.getByTestId('lifecycle-steps')).toBeVisible();

  // The services table lives on the Configuration tab.
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');
  await expect(page.getByTestId('services-table')).toBeVisible();
});

test('a freshly-analysed application shows the real §19 COMPLETE verdict', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // The fixture repo (deployz-demo/express-api) analyses as fully READY —
  // analysis completes near-instantly in fixture mode, so the page renders
  // the real verdict, not the pending state. The single state card carries
  // the verdict; the detected facts live in the Configuration tab's table.
  await expect(page.getByTestId('application-state-heading')).toHaveText('Ready for a test deployment');
  await expect(page.getByText('Analysing your application')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');

  const table = page.getByTestId('services-table');
  await expect(table).toBeVisible();
  // The detected facts now live as rows in the services table.
  await expect(page.getByTestId('readiness-setting-runtime')).toContainText('Node.js');
  await expect(page.getByTestId('readiness-setting-port')).toContainText('3000');
  await expect(page.getByTestId('readiness-setting-health')).toContainText('/health');
  // The database row's value comes from the server-computed effective
  // requirement, not the rich detected-fact text — the fixture app's `pg`
  // dependency makes it used, so the row names PostgreSQL.
  const databaseRow = page.getByTestId('readiness-setting-database');
  await expect(databaseRow).toContainText('PostgreSQL');
  await expect(databaseRow).not.toContainText('Not used');
});

test('readiness page top-level copy is jargon-free (§65)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');
  await expect(page.getByTestId('services-table')).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('re-analysing from the header menu settles back to enabled and refreshes the application row', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');
  await expect(page.getByTestId('services-table')).toBeVisible();

  const applicationId = page.url().split('/').filter(Boolean).at(-2)!;
  // Stand in for the change a real re-analysis persists: the row moves
  // underneath the page while it is on screen.
  const renamed = await page.request.patch(
    `http://localhost:${process.env.API_PORT ?? 3001}/api/applications/${applicationId}`,
    { data: { name: 'Renamed Elsewhere' } },
  );
  expect(renamed.ok()).toBe(true);

  // Re-analyse's home in normal states is the header's "More actions" menu.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByTestId('application-header-reanalyse').click();

  // The menu item must come back enabled — analysis settles, so it can be
  // run again.
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByTestId('application-header-reanalyse')).toBeEnabled({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  // ...and the page shows the row as it now is, without a manual reload. The
  // application name heading lives in the layout, shared by every tab.
  await expect(page.getByRole('heading', { name: 'Renamed Elsewhere' })).toBeVisible();
});

test('the Overview tab never shows a passed-check count, and the three tabs deep-link correctly', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // §65: the Overview never reduces readiness to a passed-check count.
  await expect(page.getByText(/checks passed/i)).toHaveCount(0);

  const applicationId = page.url().split('/').filter(Boolean).at(-1)!;
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Releases' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Configuration' })).toBeVisible();

  // Deep links load directly into the right tab.
  await page.goto(`/dashboard/applications/${applicationId}/config`);
  await expect(page.getByRole('tab', { name: 'Configuration' })).toHaveAttribute('aria-selected', 'true');

  await page.goto(`/dashboard/applications/${applicationId}/releases`);
  await expect(page.getByRole('tab', { name: 'Releases' })).toHaveAttribute('aria-selected', 'true');
});

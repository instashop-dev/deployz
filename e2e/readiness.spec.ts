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

test('onboarding page renders the six §42 steps in exact order', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/onboarding');

  const steps = page.getByTestId('onboarding-steps').getByRole('listitem');
  await expect(steps).toHaveCount(6);
  await expect(steps.nth(0)).toContainText('Connect GitHub');
  await expect(steps.nth(1)).toContainText('Choose repository');
  await expect(steps.nth(2)).toContainText('Analyse');
  await expect(steps.nth(3)).toContainText('Fix compatibility issues');
  await expect(steps.nth(4)).toContainText('Create test deployment');
  await expect(steps.nth(5)).toContainText('Ready for customer deployment');

  // The first step is the current one on the overview page.
  await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step');
});

test('choosing a repository creates a real application and opens its readiness page (§42 step 2)', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  await page.getByRole('button', { name: 'Select' }).first().click();
  // The Application row is now real — the URL carries a UUID, not a
  // fixture-repo-* id.
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  await expect(page.getByTestId('onboarding-steps')).toBeVisible();
  await expect(page.getByTestId('readiness-verdict')).toBeVisible();
});

test('a freshly-analysed application shows the real §19 COMPLETE verdict', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // The fixture repo (deployz-demo/express-api) analyses as fully READY —
  // analysis completes near-instantly in fixture mode, so the page renders
  // the real verdict, not the pending state.
  await expect(page.getByText('Ready to deploy')).toBeVisible();
  await expect(page.getByTestId('readiness-summary')).toHaveText('All checks passed');
  await expect(page.getByText('Analysing your app')).toHaveCount(0);
});

test('readiness page top-level copy is jargon-free (§65)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  await expect(page.getByTestId('readiness-verdict')).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('re-analysing settles the button back to Re-analyse and refreshes the application row', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Select' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/([0-9a-f-]{36})$/);
  await expect(page.getByTestId('readiness-verdict')).toBeVisible();

  const applicationId = page.url().split('/').pop()!;
  // Stand in for the change a real re-analysis persists: the row moves
  // underneath the page while it is on screen.
  const renamed = await page.request.patch(
    `http://localhost:${process.env.API_PORT ?? 3001}/api/applications/${applicationId}`,
    { data: { name: 'Renamed Elsewhere' } },
  );
  expect(renamed.ok()).toBe(true);

  await page.getByTestId('app-details-reanalyse').click();

  // The button must come back — analysis settles, so it can be run again.
  await expect(page.getByTestId('app-details-reanalyse')).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('app-details-reanalyse')).toHaveText('Re-analyse');
  // ...and the page shows the row as it now is, without a manual reload.
  await expect(page.getByRole('heading', { name: 'Renamed Elsewhere' })).toBeVisible();
});

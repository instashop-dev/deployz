import { expect, test, type Page } from '@playwright/test';

// §42 onboarding flow + §19 readiness page, against the REAL API. The API
// runs with GITHUB_FIXTURE_MODE (see playwright.config.ts), so the
// Applications page lists the fixture org/repos; choosing a repository now
// creates a real Application (POST /api/applications) and triggers analysis
// (POST /api/applications/:id/analyse) before navigating to it — there is no
// automated analyser wired up yet, so the readiness page for a
// freshly-created application renders the §19 pending state, never a
// fabricated verdict.

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

  await page.getByRole('button', { name: 'Choose' }).first().click();
  // The Application row is now real — the URL carries a UUID, not a
  // fixture-repo-* id.
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  await expect(page.getByTestId('onboarding-steps')).toBeVisible();
  await expect(page.getByTestId('readiness-verdict')).toBeVisible();
});

test('a freshly-analysed application shows the §19 pending state, not a fabricated verdict', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Choose' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  await expect(page.getByText('Analysing your app')).toBeVisible();
  // No score is fabricated while analysis is pending.
  await expect(page.getByText(/^\d+% —/)).toHaveCount(0);
});

test('readiness page top-level copy is jargon-free (§65)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Choose' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  await expect(page.getByTestId('readiness-verdict')).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

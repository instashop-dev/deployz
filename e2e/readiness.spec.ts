import { expect, test, type Page } from '@playwright/test';

// Todo 25 — readiness page + §42 onboarding flow. The API runs with
// GITHUB_FIXTURE_MODE (see playwright.config.ts), so the Applications page
// lists the fixture org/repos; the readiness endpoint does not exist yet, so
// the readiness page renders the fixture fallback (READY for fixture-repo-1,
// NOT_COMPATIBLE for fixture-repo-2, NEEDS_ATTENTION for fixture-repo-attention).

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

test('choosing a repository opens its readiness page (§42 step 2)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  await page.getByRole('link', { name: 'Choose' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/.+/);

  await expect(page.getByTestId('onboarding-steps')).toBeVisible();
  await expect(page.getByTestId('readiness-verdict')).toBeVisible();
});

test('readiness page renders the READY verdict + §7 free test deployment', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications/fixture-repo-1');

  await expect(page.getByRole('heading', { name: 'Your app is ready to deploy.' })).toBeVisible();

  // The current onboarding step is "Create test deployment" (step 5).
  const steps = page.getByTestId('onboarding-steps').getByRole('listitem');
  await expect(steps.nth(4)).toHaveAttribute('aria-current', 'step');

  // §7: the test-deployment CTA discloses that the vendor's own test
  // deployment is free (no per-deployment charge).
  await expect(page.getByRole('button', { name: 'Create test deployment' })).toBeVisible();
  await expect(page.getByText(/test deployment is free/)).toBeVisible();

  // §20: the AI explanation renders UNDER the deterministic verdict.
  await expect(page.getByRole('heading', { name: 'What this means' })).toBeVisible();
});

test('readiness page renders NEEDS_ATTENTION with the specific items', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications/fixture-repo-attention');

  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.getByText('Missing Dockerfile', { exact: true })).toBeVisible();
  await expect(page.getByText('Missing health endpoint', { exact: true })).toBeVisible();

  // The current onboarding step is "Fix compatibility issues" (step 4).
  const steps = page.getByTestId('onboarding-steps').getByRole('listitem');
  await expect(steps.nth(3)).toHaveAttribute('aria-current', 'step');

  // No test-deployment CTA until the app is ready.
  await expect(page.getByRole('button', { name: 'Create test deployment' })).toHaveCount(0);
});

test('readiness page renders NOT_COMPATIBLE with the rejection reason', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications/fixture-repo-2');

  await expect(page.getByRole('heading', { name: 'Not currently compatible' })).toBeVisible();
  await expect(
    page.getByText('Uses Redis for data storage, which is not supported.', { exact: true }),
  ).toBeVisible();

  // No test-deployment CTA for an incompatible app.
  await expect(page.getByRole('button', { name: 'Create test deployment' })).toHaveCount(0);
});

test('readiness page top-level copy is jargon-free (§65)', async ({ page }) => {
  await signUp(page);
  for (const id of ['fixture-repo-1', 'fixture-repo-2', 'fixture-repo-attention']) {
    await page.goto(`/dashboard/applications/${id}`);
    await expect(page.getByTestId('readiness-verdict')).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(JARGON);
  }
});

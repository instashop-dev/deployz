import { expect, test, type Page } from '@playwright/test';

// §48 billing display, against the REAL `GET /api/billing/summary` endpoint
// (previously pointed at a nonexistent /api/billing and always rendered
// fixture data). A fresh org has base-only billing: Platform $49, no
// deployment lines, Monthly total $49. §65: all top-level copy is
// jargon-free (no "Stripe", "meter event", "proration").

const JARGON = /\b(Stripe|meter event|proration|usage record|metered)\b/i;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('billing page renders the §48 base-only breakdown for a fresh org', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/settings/billing');

  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
  await expect(page.getByText('Platform', { exact: true })).toBeVisible();
  await expect(page.getByText('$49', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Monthly total')).toBeVisible();
  await expect(page.getByText('No billable deployments yet.')).toBeVisible();
});

test('billing is reachable from the dashboard nav (§41 screen 17)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard');
  await page.getByRole('navigation', { name: 'Dashboard' }).getByRole('link', { name: 'Billing' }).click();
  await page.waitForURL('**/dashboard/settings/billing');
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
});

test('billing page top-level copy is jargon-free (§65)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/settings/billing');

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

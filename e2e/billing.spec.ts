import { expect, test, type Page } from '@playwright/test';

// Todo 32 — billing display page (§48 format). The billing API endpoint
// doesn't exist yet, so the page falls back to fixture data on a 404
// (apps/web/src/lib/billing.ts). §65: all top-level copy is jargon-free
// (no "Stripe", "meter event", "proration").

// Raw billing/payment terms that must NOT appear in rendered top-level copy.
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

test('billing page renders with fixture data', async ({ page }) => {
  await signUp(page);

  // Navigate to the billing page via the settings section.
  await page.goto('/dashboard/settings/billing');

  // Page heading.
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();

  // Subscription status card.
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Current period:')).toBeVisible();

  // Line items.
  await expect(page.getByText('Base subscription')).toBeVisible();
  await expect(page.getByText('Healthy deployments')).toBeVisible();

  // Total.
  await expect(page.getByText('Total')).toBeVisible();
  await expect(page.getByText('$68.00')).toBeVisible();

  // Invoice history placeholder.
  await expect(page.getByText('Invoice history')).toBeVisible();
});

test('billing page shows base price + metered usage', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/settings/billing');

  // The fixture shows $49 base + $19 metered = $68 total.
  await expect(page.getByText('$49.00')).toBeVisible();
  await expect(page.getByText('$19.00')).toBeVisible();
  await expect(page.getByText('$68.00')).toBeVisible();

  // The metered line item shows the detail about deployment days.
  await expect(page.getByText('1 deployment × 30 days')).toBeVisible();
});

test('billing page top-level copy is jargon-free (§65)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/settings/billing');

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});
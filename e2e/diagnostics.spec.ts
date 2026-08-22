import { expect, test, type Page } from '@playwright/test';

// Todo 30 — diagnostics surface. The diagnostics endpoint doesn't exist yet,
// so the page falls back to fixture data on a 404 (apps/web/src/lib/diagnostics.ts).
// Every card renders its §61 failure in what/why/fix form with a §65
// jargon-free top level; the raw code + structured event sit behind the
// expandable "Technical detail". Code-driven only — no bundles, no log export.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('detail page links to diagnostics and the page renders the failure cards', async ({ page }) => {
  await signUp(page);

  await page.goto('/dashboard/deployments/deployment-globex-portal');

  await page.getByRole('link', { name: 'Diagnostics' }).click();
  await page.waitForURL('**/dashboard/deployments/deployment-globex-portal/diagnostics');

  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  await expect(page.getByText('Globex Portal', { exact: true })).toBeVisible();

  // §65 labels — never the raw codes — plus color-coded severity badges.
  await expect(page.getByText('Deployment failed', { exact: true })).toBeVisible();
  await expect(page.getByText('Database unreachable', { exact: true })).toBeVisible();
  await expect(page.getByText('Critical', { exact: true }).first()).toBeVisible();

  // what/why/fix structure per card (AI explanation + vocabulary fallback).
  await expect(page.getByText('What happened').first()).toBeVisible();
  await expect(page.getByText('Why it happened').first()).toBeVisible();
  await expect(page.getByText('How to fix it').first()).toBeVisible();
  await expect(
    page.getByText("The latest update didn't finish rolling out, so the app is down."),
  ).toBeVisible();
  await expect(page.getByText('The database isn\'t reachable right now.')).toBeVisible();
});

test('diagnostics top-level copy is jargon-free (technical detail collapsed)', async ({ page }) => {
  await signUp(page);

  await page.goto('/dashboard/deployments/deployment-globex-portal/diagnostics');

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
  // The raw §61 code must not leak to the collapsed top level.
  expect(text).not.toContain('ECS_DEPLOYMENT_FAILED');
});

test('expanding technical detail reveals the failure code and event source', async ({ page }) => {
  await signUp(page);

  await page.goto('/dashboard/deployments/deployment-globex-portal/diagnostics');
  // Wait for the client fetch to resolve before asserting on rendered text.
  await expect(page.getByTestId('diagnostic-card').first()).toBeVisible();

  // Collapsed: no raw code / event fields in the rendered text.
  let text = await page.locator('body').innerText();
  expect(text).not.toContain('ECS_DEPLOYMENT_FAILED');
  expect(text).not.toContain('deploy-update');

  for (const summary of await page.locator('summary').all()) {
    await summary.click();
  }

  text = await page.locator('body').innerText();
  expect(text).toContain('ECS_DEPLOYMENT_FAILED');
  expect(text).toContain('RDS_UNAVAILABLE');
  expect(text).toContain('deploy-update');
  expect(text).toContain('Failure code');
  expect(text).toContain('Event source');
});

test('healthy deployment shows the no-issues empty state', async ({ page }) => {
  await signUp(page);

  await page.goto('/dashboard/deployments/deployment-acme-analytics/diagnostics');

  await expect(
    page.getByRole('heading', { name: 'No issues found', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('This deployment is healthy, so there is nothing to diagnose.'),
  ).toBeVisible();

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

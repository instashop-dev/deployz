import { expect, test, type Page } from '@playwright/test';

// §42 application management lifecycle: list, edit, delete, delete-blocked,
// and cross-org isolation. Runs against the REAL API in GITHUB_FIXTURE_MODE
// (see playwright.config.ts), so the fixture repo deployz-demo/express-api is
// available for every Choose action.

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('application list shows existing applications', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');

  // Choose the first available repo — this creates a real Application.
  await page.getByRole('button', { name: 'Choose' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // Go back to the list — the newly-created app should appear as a card.
  await page.goto('/dashboard/applications');
  await expect(page.getByTestId(/app-card-/)).toBeVisible();
});

test('editing application details persists the change', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Choose' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // Edit the containerPort field.
  await page.getByTestId('app-details-field-containerPort').fill('8080');
  await page.getByTestId('app-details-save').click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // Reload and verify the value persisted.
  await page.reload();
  await expect(page.getByTestId('app-details-field-containerPort')).toHaveValue('8080');
});

test('deleting an application removes it from the list', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Choose' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // The fixture repo is deployz-demo/express-api — it appears as muted text
  // on the detail page.
  const repoFullName = 'deployz-demo/express-api';

  // Type the repo name into the delete confirmation field and click delete.
  await page.getByTestId('delete-app-confirm').fill(repoFullName);
  await page.getByTestId('delete-app-button').click();

  // After deletion the app list should show no card for this app.
  await page.waitForURL('/dashboard/applications');
  await expect(page.getByTestId(/app-card-/)).toHaveCount(0);
});

test('delete is blocked when the application has a deployment', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications');
  await page.getByRole('button', { name: 'Choose' }).first().click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // Capture the application id from the URL.
  const appId = page.url().match(/\/dashboard\/applications\/([0-9a-f-]{36})/)![1]!;

  // Create a customer + deployment via direct API calls using the session cookie.
  const cookies = await page.context().cookies();
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const customerRes = await page.request.post('http://localhost:3001/api/customers', {
    data: { name: 'Test Customer', email: 'test@example.com' },
    headers: { cookie },
  });
  const customer = await customerRes.json();

  await page.request.post('http://localhost:3001/api/deployments', {
    data: { applicationId: appId, customerId: customer.id, region: 'us-east-1' },
    headers: { cookie },
  });

  // Now try to delete — the 409 should block it.
  const repoFullName = 'deployz-demo/express-api';
  await page.getByTestId('delete-app-confirm').fill(repoFullName);
  await page.getByTestId('delete-app-button').click();

  // Expect an error message indicating the delete was blocked.
  await expect(page.getByText(/cannot delete/i)).toBeVisible();
});

test('cross-org isolation: cannot PATCH or DELETE another org\'s application', async ({
  page,
  browser,
}) => {
  // Org A: sign up, choose a repo, capture the app id.
  const orgAContext = await browser.newContext();
  const orgAPage = await orgAContext.newPage();
  await signUp(orgAPage);
  await orgAPage.goto('/dashboard/applications');
  await orgAPage.getByRole('button', { name: 'Choose' }).first().click();
  await orgAPage.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);
  const appId = orgAPage.url().match(/\/dashboard\/applications\/([0-9a-f-]{36}$)/)![1]!;

  // Org B: sign up in a separate context, get its cookie.
  const orgBContext = await browser.newContext();
  const orgBPage = await orgBContext.newPage();
  await signUp(orgBPage);

  const orgBCookies = await orgBContext.cookies();
  const orgBCookie = orgBCookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Org B tries to PATCH org A's application — expect 404.
  const patchRes = await orgBPage.request.patch(`http://localhost:3001/api/applications/${appId}`, {
    data: { name: 'hacked' },
    headers: { cookie: orgBCookie, 'content-type': 'application/json' },
  });
  expect(patchRes.status()).toBe(404);

  // Org B tries to DELETE org A's application — expect 404.
  const deleteRes = await orgBPage.request.delete(
    `http://localhost:3001/api/applications/${appId}`,
    { headers: { cookie: orgBCookie } },
  );
  expect(deleteRes.status()).toBe(404);

  await orgAContext.close();
  await orgBContext.close();
});
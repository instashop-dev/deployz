import { expect, test } from '@playwright/test';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

// U7 end-to-end: browser signup on the Next.js UI sets a session cookie (from
// the Fastify API); the Next.js SERVER then honors that cookie when it calls
// the API — proving cross-surface session sharing without any client tricks.
// The proof renders in the dashboard shell: the server-side layout resolves
// the session via fetchMe() and shows the user identity + tenant name.
test('signup via the web UI lands authenticated and the API honors the session server-side', async ({
  page,
}) => {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;

  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.waitForURL('/dashboard');
  await expect(page.getByTestId('user-menu-trigger')).toContainText('E2E User');
  await page.getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('user-menu-email')).toHaveText(email);
  // Tenant provisioning proof: the org name derives from the email local part.
  await expect(page.getByTestId('org-name')).toHaveText(email.split('@')[0] ?? '');
});

// The login half of U7: an account created straight against the API signs in
// through the web form and the same server-side session proof holds.
test('signin via the web form honors an existing account', async ({ page, request }) => {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = 'super-secret-1';
  const created = await request.post(
    `${API_URL}/api/auth/sign-up/email`,
    { data: { name: 'E2E User', email, password } },
  );
  expect(created.ok()).toBeTruthy();

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('user-menu-email')).toHaveText(email);
});

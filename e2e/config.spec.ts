import { expect, test, type Page } from '@playwright/test';

// Todo 26 — §31 application configuration screen. The config API exists but
// the fixture application ids have no backend rows, so GET/PUT 404 and the
// client falls back to fixture data (same pattern as todo 19/25). The
// load-bearing assertions are the secret boundary: secrets render masked
// (empty password inputs, never plaintext), and a saved secret travels on
// the write path only — the DOM never shows it afterwards.

interface ConfigWriteBody {
  customerId?: string | null;
  entries?: { key: string; value: string; isSecret: boolean }[];
}

async function signUp(page: Page): Promise<void> {
  const email = `e2e-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

// Capture PUT bodies (the write path) and answer 404 so the client takes the
// fixture fallback; GETs continue to the real API (which 404s on its own).
async function captureConfigWrites(page: Page, sink: { body: ConfigWriteBody | null }): Promise<void> {
  await page.route('**/api/applications/*/config', async (route) => {
    if (route.request().method() === 'PUT') {
      sink.body = route.request().postDataJSON() as ConfigWriteBody;
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Application not found' } }),
      });
      return;
    }
    await route.continue();
  });
}

test('application detail page links to the configuration screen', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications/fixture-repo-1');

  await page.getByRole('link', { name: 'Configuration' }).click();
  await page.waitForURL(/\/dashboard\/applications\/fixture-repo-1\/config/);

  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();
});

test('config screen renders vendor defaults and customer overrides (fixture)', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications/fixture-repo-1/config');

  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();

  const defaults = page.getByTestId('config-vendor-defaults');
  await expect(defaults.getByLabel('DATABASE_URL')).toBeVisible();
  await expect(defaults.getByLabel('LOG_LEVEL')).toHaveValue('info');
  await expect(defaults.getByLabel('MAX_CONNECTIONS')).toHaveValue('10');

  const overrides = page.getByTestId('config-customer-overrides');
  await expect(overrides.getByLabel('LOG_LEVEL')).toHaveValue('debug');
  await expect(overrides.getByLabel('API_KEY')).toBeVisible();
  // An override shows the vendor default it shadows.
  await expect(overrides.getByText('Default: info')).toBeVisible();

  // §65: no raw infrastructure jargon in the rendered copy.
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i);
});

test('secrets render masked — empty password inputs, never plaintext', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications/fixture-repo-1/config');
  await expect(page.getByTestId('config-vendor-defaults')).toBeVisible();

  // DATABASE_URL (vendor default) + API_KEY (customer override) are secrets.
  const passwordInputs = page.locator('input[type="password"]');
  await expect(passwordInputs).toHaveCount(2);
  for (const input of await passwordInputs.all()) {
    await expect(input).toHaveValue('');
  }
  await expect(page.getByText('Secret set — enter a new value to replace it.')).toHaveCount(2);

  // No secret-looking payload exists anywhere in the DOM.
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/postgres:\/\/|hunter2|super-secret-value/);
});

test('secret fields are write-only password inputs with a show/hide toggle', async ({ page }) => {
  await signUp(page);
  await page.goto('/dashboard/applications/fixture-repo-1/config');

  const defaults = page.getByTestId('config-vendor-defaults');
  const secretField = defaults.getByLabel('DATABASE_URL');
  await expect(secretField).toHaveAttribute('type', 'password');
  await expect(secretField).toHaveAttribute('autocomplete', 'new-password');

  await defaults.getByRole('button', { name: 'Show value' }).click();
  await expect(secretField).toHaveAttribute('type', 'text');
  await defaults.getByRole('button', { name: 'Hide value' }).click();
  await expect(secretField).toHaveAttribute('type', 'password');
});

test('saving defaults sends the write and confirms', async ({ page }) => {
  await signUp(page);
  const sink: { body: ConfigWriteBody | null } = { body: null };
  await captureConfigWrites(page, sink);

  await page.goto('/dashboard/applications/fixture-repo-1/config');
  const defaults = page.getByTestId('config-vendor-defaults');
  await defaults.getByLabel('LOG_LEVEL').fill('warn');
  await defaults.getByRole('button', { name: 'Save defaults' }).click();

  await expect(defaults.getByRole('status')).toHaveText('Saved.');

  // The write path carried the whole defaults group (vendor scope: null
  // customer) with the edited value; the untouched secret went along empty.
  expect(sink.body).toMatchObject({ customerId: null });
  const entries = sink.body?.entries ?? [];
  expect(entries.find((entry) => entry.key === 'LOG_LEVEL')).toMatchObject({ value: 'warn' });
  expect(entries.find((entry) => entry.key === 'DATABASE_URL')).toMatchObject({
    isSecret: true,
    value: '',
  });

  // After the save the field shows the saved value (form remounts fresh).
  await expect(defaults.getByLabel('LOG_LEVEL')).toHaveValue('warn');
});

test('saving a secret sends the new value on the write path but never renders it', async ({
  page,
}) => {
  await signUp(page);
  const sink: { body: ConfigWriteBody | null } = { body: null };
  await captureConfigWrites(page, sink);

  await page.goto('/dashboard/applications/fixture-repo-1/config');
  const overrides = page.getByTestId('config-customer-overrides');
  await overrides.getByLabel('API_KEY').fill('e2e-brand-new-secret-value');
  await overrides.getByRole('button', { name: 'Save overrides' }).click();

  await expect(overrides.getByRole('status')).toHaveText('Saved.');

  // The write path carried the NEW secret to the API (the §31 relay
  // write-through needs it), scoped to the fixture customer.
  expect(sink.body?.customerId).toBe('fixture-customer-acme');
  const apiKeyWrite = sink.body?.entries?.find((entry) => entry.key === 'API_KEY');
  expect(apiKeyWrite).toMatchObject({ isSecret: true, value: 'e2e-brand-new-secret-value' });

  // The DOM never renders the secret: the field reset to an empty password
  // input and the plaintext appears nowhere.
  await expect(overrides.getByLabel('API_KEY')).toHaveValue('');
  await expect(overrides.getByLabel('API_KEY')).toHaveAttribute('type', 'password');
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('e2e-brand-new-secret-value');
});

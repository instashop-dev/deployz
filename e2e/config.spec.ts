import { expect, test, type Page } from '@playwright/test';

// §31 application configuration screen, against the REAL API (no fixture
// fallback — a 404 is surfaced, never swallowed, per apps/web/src/lib/
// config.ts). Seeds a real application, customer, and config rows directly
// via the API (through the browser's session cookie) before driving the UI.
// The load-bearing assertions are the secret boundary: secrets render masked
// (empty password inputs, never plaintext), and a saved secret travels on
// the write path only — the DOM never shows it afterwards.

const API_URL = 'http://localhost:3001';

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

async function createApplication(page: Page): Promise<{ id: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const response = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Config Test ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/config-test-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/config-test-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function createCustomer(page: Page): Promise<{ id: string; name: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const response = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Config Customer ${suffix}`, email: `config-${suffix}@example.com` },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function putConfig(
  page: Page,
  applicationId: string,
  customerId: string | null,
  entries: { key: string; value: string; isSecret: boolean }[],
): Promise<void> {
  const response = await page.request.put(`${API_URL}/api/applications/${applicationId}/config`, {
    data: { customerId, entries },
  });
  expect(response.ok()).toBeTruthy();
}

/** Seeds a real application + customer with vendor defaults and customer overrides. */
async function seedAppWithConfig(
  page: Page,
): Promise<{ applicationId: string; customerId: string; customerName: string }> {
  const application = await createApplication(page);
  const customer = await createCustomer(page);
  await putConfig(page, application.id, null, [
    { key: 'DATABASE_URL', value: 'postgres://e2e-seed-vendor-value', isSecret: true },
    { key: 'LOG_LEVEL', value: 'info', isSecret: false },
    { key: 'MAX_CONNECTIONS', value: '10', isSecret: false },
  ]);
  await putConfig(page, application.id, customer.id, [
    { key: 'LOG_LEVEL', value: 'debug', isSecret: false },
    { key: 'API_KEY', value: 'e2e-seed-customer-secret', isSecret: true },
  ]);
  return { applicationId: application.id, customerId: customer.id, customerName: customer.name };
}

test('application detail page links to the configuration screen', async ({ page }) => {
  await signUp(page);
  // A real application (fixture-repo-1 is a GitHub repo id, not a Deployz
  // application id — the readiness page 404s for anything that isn't a real
  // UUID application, by design).
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `express-api-${crypto.randomUUID().slice(0, 8)}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: 'deployz-demo/express-api',
      repoUrl: 'https://github.com/deployz-demo/express-api',
      defaultBranch: 'main',
    },
  });
  const application = (await appResponse.json()) as { id: string };

  await page.goto(`/dashboard/applications/${application.id}`);
  await page.getByRole('link', { name: 'Configuration' }).click();
  await page.waitForURL(`**/dashboard/applications/${application.id}/config`);

  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();
});

test('config screen renders vendor defaults and customer overrides', async ({ page }) => {
  await signUp(page);
  const { applicationId, customerId } = await seedAppWithConfig(page);
  await page.goto(`/dashboard/applications/${applicationId}/config?customer=${customerId}`);

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
  const { applicationId, customerId } = await seedAppWithConfig(page);
  await page.goto(`/dashboard/applications/${applicationId}/config?customer=${customerId}`);
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
  expect(text).not.toMatch(/postgres:\/\//);
  expect(text).not.toContain('e2e-seed-customer-secret');
});

test('secret fields are write-only password inputs with a show/hide toggle', async ({ page }) => {
  await signUp(page);
  const { applicationId } = await seedAppWithConfig(page);
  await page.goto(`/dashboard/applications/${applicationId}/config`);

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
  const { applicationId } = await seedAppWithConfig(page);

  await page.goto(`/dashboard/applications/${applicationId}/config`);
  const defaults = page.getByTestId('config-vendor-defaults');
  await defaults.getByLabel('LOG_LEVEL').fill('warn');

  const [request] = await Promise.all([
    page.waitForRequest(
      (req) =>
        req.url() === `${API_URL}/api/applications/${applicationId}/config` &&
        req.method() === 'PUT',
    ),
    defaults.getByRole('button', { name: 'Save defaults' }).click(),
  ]);

  await expect(defaults.getByRole('status')).toHaveText('Saved.');

  // The write path carried the whole defaults group (vendor scope: null
  // customer) with the edited value; the untouched secret went along empty.
  const body = request.postDataJSON() as ConfigWriteBody;
  expect(body).toMatchObject({ customerId: null });
  const entries = body.entries ?? [];
  expect(entries.find((entry) => entry.key === 'LOG_LEVEL')).toMatchObject({ value: 'warn' });
  expect(entries.find((entry) => entry.key === 'DATABASE_URL')).toMatchObject({
    isSecret: true,
    value: '',
  });

  // After the save the field shows the saved value (form remounts fresh).
  await expect(defaults.getByLabel('LOG_LEVEL')).toHaveValue('warn');
});

test('saving defaults through the UI persists to the real API (regression: CORS blocked PUT)', async ({
  page,
}) => {
  await signUp(page);
  const { applicationId } = await seedAppWithConfig(page);

  await page.goto(`/dashboard/applications/${applicationId}/config`);
  const defaults = page.getByTestId('config-vendor-defaults');
  const newValue = `warn-${crypto.randomUUID().slice(0, 8)}`;
  await defaults.getByLabel('LOG_LEVEL').fill(newValue);
  await defaults.getByRole('button', { name: 'Save defaults' }).click();
  await expect(defaults.getByRole('status')).toHaveText('Saved.');

  // Previously the API's CORS config only allowed GET,HEAD,POST, so the
  // browser blocked the PUT preflight and every config save silently failed
  // in the browser even though a mocked test would still show "Saved.". This
  // reads the value back through the real API to prove the write actually
  // landed in the database.
  const readBack = await page.request.get(`${API_URL}/api/applications/${applicationId}/config`);
  expect(readBack.ok()).toBeTruthy();
  const config = (await readBack.json()) as {
    vendorDefaults: { key: string; value: string | null }[];
  };
  expect(config.vendorDefaults.find((entry) => entry.key === 'LOG_LEVEL')?.value).toBe(newValue);
});

test('saving a secret sends the new value on the write path but never renders it', async ({
  page,
}) => {
  await signUp(page);
  const { applicationId, customerId } = await seedAppWithConfig(page);

  await page.goto(`/dashboard/applications/${applicationId}/config?customer=${customerId}`);
  const overrides = page.getByTestId('config-customer-overrides');
  await overrides.getByLabel('API_KEY').fill('e2e-brand-new-secret-value');

  const [request] = await Promise.all([
    page.waitForRequest(
      (req) =>
        req.url() === `${API_URL}/api/applications/${applicationId}/config` &&
        req.method() === 'PUT',
    ),
    overrides.getByRole('button', { name: 'Save overrides' }).click(),
  ]);

  await expect(overrides.getByRole('status')).toHaveText('Saved.');

  // The write path carried the NEW secret to the API (the §31 relay
  // write-through needs it), scoped to the real customer.
  const body = request.postDataJSON() as ConfigWriteBody;
  expect(body.customerId).toBe(customerId);
  const apiKeyWrite = body.entries?.find((entry) => entry.key === 'API_KEY');
  expect(apiKeyWrite).toMatchObject({ isSecret: true, value: 'e2e-brand-new-secret-value' });

  // The DOM never renders the secret: the field reset to an empty password
  // input and the plaintext appears nowhere.
  await expect(overrides.getByLabel('API_KEY')).toHaveValue('');
  await expect(overrides.getByLabel('API_KEY')).toHaveAttribute('type', 'password');
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('e2e-brand-new-secret-value');
});

test('the customer overrides group names the customer, never its id', async ({ page }) => {
  await signUp(page);
  const { applicationId, customerId, customerName } = await seedAppWithConfig(page);
  await page.goto(`/dashboard/applications/${applicationId}/config?customer=${customerId}`);

  const overrides = page.getByTestId('config-customer-overrides');
  await expect(overrides).toContainText(`Apply to ${customerName} only.`);

  // A customer id is an internal identifier — it appears nowhere on the page.
  const text = await page.locator('body').innerText();
  expect(text).not.toContain(customerId);
});

test('a group with no values yet offers a way to add one, and the add persists', async ({
  page,
}) => {
  await signUp(page);
  const application = await createApplication(page);
  await page.goto(`/dashboard/applications/${application.id}/config`);

  const defaults = page.getByTestId('config-vendor-defaults');
  await expect(defaults).toContainText('No defaults set yet.');

  await defaults.getByTestId('config-vendor-defaults-add-value').click();
  await defaults.getByLabel('Name', { exact: true }).fill('LOG_LEVEL');
  await defaults.getByLabel('Value', { exact: true }).fill('info');
  await defaults.getByRole('button', { name: 'Save defaults' }).click();
  await expect(defaults.getByRole('status')).toHaveText('Saved.');

  // The added value is now a normal field, and it really landed in the API.
  await expect(defaults.getByLabel('LOG_LEVEL')).toHaveValue('info');
  const readBack = await page.request.get(`${API_URL}/api/applications/${application.id}/config`);
  expect(readBack.ok()).toBeTruthy();
  const config = (await readBack.json()) as {
    vendorDefaults: { key: string; value: string | null; isSecret: boolean }[];
  };
  expect(config.vendorDefaults).toContainEqual({ key: 'LOG_LEVEL', value: 'info', isSecret: false });
});

test('a secret can be added, and the new value never renders after saving', async ({ page }) => {
  await signUp(page);
  const { applicationId, customerId } = await seedAppWithConfig(page);
  await page.goto(`/dashboard/applications/${applicationId}/config?customer=${customerId}`);

  const overrides = page.getByTestId('config-customer-overrides');
  await overrides.getByTestId('config-customer-overrides-add-secret').click();
  await overrides.getByLabel('Name', { exact: true }).fill('SMTP_PASSWORD');
  await overrides.getByLabel('Value', { exact: true }).fill('e2e-brand-new-added-secret');
  await expect(overrides.getByLabel('Value', { exact: true })).toHaveAttribute('type', 'password');

  const [request] = await Promise.all([
    page.waitForRequest(
      (req) =>
        req.url() === `${API_URL}/api/applications/${applicationId}/config` &&
        req.method() === 'PUT',
    ),
    overrides.getByRole('button', { name: 'Save overrides' }).click(),
  ]);
  await expect(overrides.getByRole('status')).toHaveText('Saved.');

  // The new secret travelled on the write path only.
  const body = request.postDataJSON() as ConfigWriteBody;
  expect(body.entries?.find((entry) => entry.key === 'SMTP_PASSWORD')).toMatchObject({
    isSecret: true,
    value: 'e2e-brand-new-added-secret',
  });

  // It comes back masked: a write-only field, and no plaintext anywhere.
  await expect(overrides.getByLabel('SMTP_PASSWORD')).toHaveValue('');
  await expect(overrides.getByLabel('SMTP_PASSWORD')).toHaveAttribute('type', 'password');
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('e2e-brand-new-added-secret');
});

test('adding a value that is already in the group is refused before any write', async ({ page }) => {
  await signUp(page);
  const { applicationId } = await seedAppWithConfig(page);
  await page.goto(`/dashboard/applications/${applicationId}/config`);

  const defaults = page.getByTestId('config-vendor-defaults');
  await defaults.getByTestId('config-vendor-defaults-add-value').click();
  await defaults.getByLabel('Name', { exact: true }).fill('LOG_LEVEL');
  await defaults.getByLabel('Value', { exact: true }).fill('debug');

  let wrote = false;
  page.on('request', (req) => {
    if (req.url() === `${API_URL}/api/applications/${applicationId}/config` && req.method() === 'PUT') {
      wrote = true;
    }
  });
  await defaults.getByRole('button', { name: 'Save defaults' }).click();

  await expect(defaults.getByRole('alert')).toContainText('LOG_LEVEL is already in this group.');
  expect(wrote).toBe(false);
});

test('saving the defaults keeps the customer scope intact (regression: overrides went read-only)', async ({
  page,
}) => {
  await signUp(page);
  const { applicationId, customerId, customerName } = await seedAppWithConfig(page);
  await page.goto(`/dashboard/applications/${applicationId}/config?customer=${customerId}`);

  const defaults = page.getByTestId('config-vendor-defaults');
  await defaults.getByLabel('LOG_LEVEL').fill('warn');
  await defaults.getByRole('button', { name: 'Save defaults' }).click();
  await expect(defaults.getByRole('status')).toHaveText('Saved.');

  // The defaults write answers for the VENDOR scope only. Folding that whole
  // answer back into the page dropped the customer, so the overrides group
  // lost its name and its Save button. Both must survive the save.
  const overrides = page.getByTestId('config-customer-overrides');
  await expect(overrides).toContainText(`Apply to ${customerName} only.`);
  await expect(overrides.getByRole('button', { name: 'Save overrides' })).toBeVisible();
  await expect(overrides.getByLabel('LOG_LEVEL')).toHaveValue('debug');
  // The overrides still shadow the freshly saved default.
  await expect(overrides.getByText('Default: warn')).toBeVisible();
});

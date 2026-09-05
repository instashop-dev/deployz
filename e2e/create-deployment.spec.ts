import { expect, test, type Page } from '@playwright/test';

// CANARY-004: the create-deployment form (§12/§41 screen 12) used to swallow
// every /api/deployments failure behind a fixed "Try again in a moment" and
// re-created the customer on every retry. Seeds a real Application from the
// `deployz-demo/legacy-redis` fixture repo (see e2e/redis.spec.ts) — its
// unsupported Redis Stack dependency makes `evaluateManifestReadiness`
// (packages/analysis/src/manifest.ts) return NOT_COMPATIBLE, so
// POST /api/deployments genuinely rejects with 422 MANIFEST_NOT_COMPATIBLE
// against the real API — no fabricated failure.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-canary004-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Canary Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

/** Mirrors e2e/redis.spec.ts's `seedAnalysedApplication`. */
async function seedNotCompatibleApplication(page: Page, suffix: string): Promise<string> {
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Canary Test ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: 'deployz-demo/legacy-redis',
      repoUrl: 'https://github.com/deployz-demo/legacy-redis',
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };

  const analyseResponse = await page.request.post(
    `${API_URL}/api/applications/${application.id}/analyse`,
  );
  expect(analyseResponse.ok()).toBeTruthy();

  return application.id;
}

test('a MANIFEST_NOT_COMPATIBLE rejection shows the server reason, links to readiness, and does not duplicate the customer on retry', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const customerEmail = `canary-customer-${suffix}@example.com`;

  await signUp(page);
  const applicationId = await seedNotCompatibleApplication(page, suffix);

  await page.goto(`/dashboard/deployments/new?applicationId=${applicationId}`);
  await page.getByLabel('Customer name').fill(`Canary ${suffix}`);
  await page.getByLabel('Customer email').fill(customerEmail);

  const submit = page.getByRole('button', { name: 'Create Customer Deployment' });
  // Scoped to the form: Next.js's own route announcer also carries
  // role="alert" and would otherwise make this locator ambiguous.
  const alert = page.locator('form [role="alert"]');

  // Phase 5: the preflight shows the gate's answer before the vendor submits.
  const preflight = page.getByTestId('preflight-summary');
  await expect(preflight).toBeVisible();
  await expect(preflight).toHaveAttribute('data-state', 'UNSUPPORTED');
  await expect(page.getByTestId('preflight-heading')).toContainText("Can't deploy this application yet");

  await submit.click();
  await expect(alert).toContainText(
    'This application cannot be deployed with Deployz as configured.',
  );
  await expect(
    alert.getByRole('link', { name: "Review the application's readiness findings" }),
  ).toHaveAttribute('href', `/dashboard/applications/${applicationId}`);

  // Retry with the same customer details: the API rejects again (the
  // manifest is still NOT_COMPATIBLE), but no second customer row should be
  // created — the page must reuse the id from the first attempt.
  await submit.click();
  await expect(alert).toContainText(
    'This application cannot be deployed with Deployz as configured.',
  );

  const customersResponse = await page.request.get(`${API_URL}/api/customers`);
  expect(customersResponse.ok()).toBeTruthy();
  const { customers } = (await customersResponse.json()) as {
    customers: { email: string }[];
  };
  expect(customers.filter((customer) => customer.email === customerEmail)).toHaveLength(1);
});

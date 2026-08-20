import { expect, test } from '@playwright/test';

// Todo 11 — public install + trust pages, exercised against a fixture install
// link (no backend, no AWS; the live-link proof is PENDING-AWS, todo 14).
// The pages must render for an anonymous visitor (the middleware matcher does
// not cover /install), present the "AWS auth happens at AWS" framing, keep
// raw service terminology out of the top-level copy (§65), and reveal the
// exact permissions only inside expanded technical detail (§45).

const INSTALL_ID = 'e2e-fixture-install-01';

// Raw AWS service terms that must NOT appear in rendered top-level copy.
// ("AWS" itself is fine — §44's framing is "AWS auth happens at AWS".)
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC)\b/;

test('install page renders publicly with the Deploy to AWS CTA', async ({ page }) => {
  const response = await page.goto(`/install/${INSTALL_ID}`);
  expect(response?.status()).toBe(200);
  expect(page.url()).toContain(`/install/${INSTALL_ID}`);

  await expect(page.getByRole('heading', { name: 'Install your app' })).toBeVisible();

  const cta = page.getByRole('link', { name: 'Deploy to AWS' });
  await expect(cta).toBeVisible();
  const href = await cta.getAttribute('href');
  expect(href).toContain('console.aws.amazon.com/cloudformation');
  expect(href).toContain('templateURL=');
  expect(href).toContain('stackName=deployz-bootstrap');
  expect(href).toContain('param_ControlPlaneUrl=');
  // The URL carries no credential or installation identifier.
  expect(href).not.toMatch(/token|secret|credential|installationId/i);

  // §44 framing: the customer authenticates at their own cloud provider.
  await expect(page.getByText(/AWS auth happens at AWS/)).toBeVisible();

  // Plain-English relay explanation (§65).
  await expect(page.getByText(/small helper that runs in your cloud account/)).toBeVisible();

  // The unique installation reference is shown.
  await expect(page.getByText(INSTALL_ID)).toBeVisible();
});

test('install page top-level copy is jargon-free', async ({ page }) => {
  await page.goto(`/install/${INSTALL_ID}`);
  // innerText reflects RENDERED text — collapsed <details> content excluded.
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('security page top level is jargon-free and tells the honest story', async ({ page }) => {
  const response = await page.goto(`/install/${INSTALL_ID}/security`);
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'Security details' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What the relay can do' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What the relay can never do' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The honest version' })).toBeVisible();

  // §45 honesty: no overclaiming "tightly scoped" — the page says the
  // post-check-in permissions are substantial but bounded.
  await expect(page.getByText(/won.t claim these permissions are tiny/)).toBeVisible();
  await expect(page.getByText(/substantial permissions/)).toBeVisible();

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('security page reveals the actual permissions only after expanding', async ({ page }) => {
  await page.goto(`/install/${INSTALL_ID}/security`);

  // Collapsed: no technical permission names in the rendered text.
  let text = await page.locator('body').innerText();
  expect(text).not.toContain('cloudformation:CreateStack');
  expect(text).not.toContain('logs:PutLogEvents');
  expect(text).not.toContain('iam:PassRole');

  // Expand every technical-detail section.
  for (const summary of await page.locator('summary').all()) {
    await summary.click();
  }

  text = await page.locator('body').innerText();
  // Phase 1 (install-time) permissions.
  expect(text).toContain('logs:PutLogEvents');
  expect(text).toContain('secretsmanager:GetSecretValue');
  // Phase 2 (post-first-contact) permissions + the tag boundary.
  expect(text).toContain('cloudformation:CreateStack');
  expect(text).toContain('cloudformation:DeleteStack');
  expect(text).toContain('ecs:UpdateService');
  expect(text).toContain('rds:DescribeDBInstances');
  expect(text).toContain('iam:PassRole');
  expect(text).toContain('aws:RequestTag/deployz:installation');
  expect(text).toContain('aws:ResourceTag/deployz:installation');
  // §16 data boundary: the denied log-read actions are disclosed as NOT granted.
  expect(text).toContain('logs:GetLogEvents');
  expect(text).toContain('logs:FilterLogEvents');
});

test('install page links to security details and back', async ({ page }) => {
  await page.goto(`/install/${INSTALL_ID}`);
  await page.getByRole('link', { name: 'Security details' }).click();
  await page.waitForURL(`/install/${INSTALL_ID}/security`);
  await expect(page.getByRole('heading', { name: 'Security details' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to install' }).click();
  await page.waitForURL(`/install/${INSTALL_ID}`);
  await expect(page.getByRole('heading', { name: 'Install your app' })).toBeVisible();
});

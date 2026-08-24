import { expect, test, type APIRequestContext } from '@playwright/test';

// §44 public install page + §45 trust page, against the REAL (public,
// no-auth) `GET /api/install/:installLinkId` endpoint. Seeds a real
// application/customer/deployment directly against the API (no browser
// session needed — these routes are unauthenticated by design, §44) to get a
// real installLinkId, then visits the public pages as an anonymous
// customer. Unknown installation ids now get an honest not-found state
// instead of fabricated content.

const API_URL = 'http://localhost:3001';

// Raw AWS service terms that must NOT appear in rendered top-level copy.
// ("AWS" itself is fine — §44's framing is "AWS auth happens at AWS".)
const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC)\b/;

async function seedInstall(
  request: APIRequestContext,
): Promise<{ installLinkId: string; applicationName: string; publisherName: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `e2e-install-${suffix}@example.com`;
  const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { name: `Install Vendor ${suffix}`, email, password: 'super-secret-1' },
  });
  expect(signUp.ok()).toBeTruthy();

  const appResponse = await request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Analytics Cloud ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/analytics-cloud-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/analytics-cloud-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string; name: string };

  const customerResponse = await request.post(`${API_URL}/api/customers`, {
    data: { name: `Acme Corp ${suffix}`, email: `acme-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string };

  const deploymentResponse = await request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as { installLinkId: string };

  return {
    installLinkId: deployment.installLinkId,
    applicationName: application.name,
    publisherName: `Install Vendor ${suffix}`,
  };
}

test('unknown installation id renders an honest not-found state', async ({ page }) => {
  const response = await page.goto('/install/no-such-installation-id');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: "This link isn't valid" })).toBeVisible();
  // Never fabricates a CTA for a link that doesn't resolve to anything real.
  await expect(page.getByRole('link', { name: 'Deploy to AWS' })).toHaveCount(0);
});

test('install page renders the real application/publisher and the Deploy to AWS CTA', async ({
  page,
  request,
}) => {
  const { installLinkId, applicationName } = await seedInstall(request);

  const response = await page.goto(`/install/${installLinkId}`);
  expect(response?.status()).toBe(200);

  await expect(page.getByText(applicationName, { exact: true })).toBeVisible();
  await expect(page.getByText('Deployz will create')).toBeVisible();
  await expect(page.getByText('Your data stays in your AWS account.')).toBeVisible();
  // §12 verbatim lists.
  await expect(page.getByText('Deploy application releases')).toBeVisible();
  await expect(page.getByText('Access your AWS account credentials')).toBeVisible();

  const cta = page.getByRole('link', { name: 'Deploy to AWS' });
  await expect(cta).toBeVisible();
  const href = await cta.getAttribute('href');
  expect(href).toContain('console.aws.amazon.com/cloudformation');
  expect(href).toContain('templateURL=');
  expect(href).toContain('stackName=deployz-bootstrap');
  expect(href).toContain('param_ControlPlaneUrl=');
  // The single-use enrollment code is what ties this stack to the vendor's
  // deployment. The relay's own communication credential is still minted by
  // CloudFormation inside the customer's account and never travels here.
  expect(href).toContain('param_EnrollmentCode=');
  expect(href).not.toMatch(/token|secret|credential|installationId/i);

  // §44 framing: the customer authenticates at their own cloud provider.
  await expect(page.getByText(/AWS auth happens at AWS/)).toBeVisible();
  // Plain-English relay explanation (§65).
  await expect(page.getByText(/small helper that runs in your cloud account/)).toBeVisible();
  // The unique installation reference is shown.
  await expect(page.getByText(installLinkId)).toBeVisible();
});

test('install page top-level copy is jargon-free', async ({ page, request }) => {
  const { installLinkId } = await seedInstall(request);
  await page.goto(`/install/${installLinkId}`);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('security page top level is jargon-free and tells the honest story', async ({
  page,
  request,
}) => {
  // A real install link. This page used to render the full security story for
  // ANY id, including ones the parent route had already called invalid.
  const { installLinkId } = await seedInstall(request);
  const response = await page.goto(`/install/${installLinkId}/security`);
  expect(response?.status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'Security details' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Exact AWS resources created' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How it fits together' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What the relay can do' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What the relay can never do' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The honest version' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Data sent to Deployz' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Data not sent to Deployz' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How to revoke Deployz' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How deletion works' })).toBeVisible();

  // §45 honesty: no overclaiming "tightly scoped" — the page says the
  // post-check-in permissions are substantial but bounded.
  await expect(page.getByText(/won.t claim these permissions are tiny/)).toBeVisible();
  await expect(page.getByText(/substantial permissions/)).toBeVisible();

  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(JARGON);
});

test('security page reveals the actual permissions only after expanding', async ({
  page,
  request,
}) => {
  const { installLinkId } = await seedInstall(request);
  await page.goto(`/install/${installLinkId}/security`);

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

test('install page links to security details and back', async ({ page, request }) => {
  const { installLinkId } = await seedInstall(request);
  await page.goto(`/install/${installLinkId}`);
  await page.getByRole('link', { name: 'Security details' }).click();
  await page.waitForURL(`**/install/${installLinkId}/security`);
  await expect(page.getByRole('heading', { name: 'Security details' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to install' }).click();
  await page.waitForURL(`**/install/${installLinkId}`);
  await expect(page.getByText('Deployz will create')).toBeVisible();
});

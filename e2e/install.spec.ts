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
): Promise<{
  installLinkId: string;
  deploymentId: string;
  applicationId: string;
  customerId: string;
  applicationName: string;
  publisherName: string;
}> {
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
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
  };

  return {
    installLinkId: deployment.installLinkId,
    deploymentId: deployment.id,
    applicationId: application.id,
    customerId: customer.id,
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
  // The console deep-link targets the deployment's OWN region, which only the
  // control plane knows — the web app never hardcodes one.
  expect(href).toContain('region=us-east-1');
  // The single-use enrollment code is what ties this stack to the vendor's
  // deployment. The relay's own communication credential is still minted by
  // CloudFormation inside the customer's account and never travels here.
  expect(href).toContain('param_EnrollmentCode=');
  // The URL carries no credential or installation identifier.
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

test('a setup link that has already been used says so instead of leading to a dead end', async ({
  page,
  request,
}) => {
  const { installLinkId } = await seedInstall(request);

  // Enrol a relay, which spends the single-use code. The code travels only
  // inside the Quick Create link (never as its own response field), so read
  // it back out of the link the install page hands the customer. The
  // console deep-link carries its parameters after the `#` fragment, not in
  // the URL query — `searchParams` alone would not see them.
  const install = await request.get(`${API_URL}/api/install/${installLinkId}`);
  const { quickCreateUrl } = (await install.json()) as { quickCreateUrl: string };
  expect(quickCreateUrl).not.toBeNull();
  const fragmentQuery = new URL(quickCreateUrl).hash.split('?')[1] ?? '';
  const enrollmentCode = new URLSearchParams(fragmentQuery).get('param_EnrollmentCode')!;
  const register = await request.post(`${API_URL}/api/relay/register`, {
    headers: { Authorization: 'Bearer relay-token-for-e2e' },
    data: { installationId: `inst-${crypto.randomUUID()}`, enrollmentCode },
  });
  expect(register.ok()).toBeTruthy();

  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('heading', { name: 'Analytics Cloud', exact: false }).first()).toBeVisible();
  await expect(page.getByText(/Running in your cloud account/)).toBeVisible();
  // Running the setup again would fail only AFTER the customer approved a
  // stack in their own account, so the CTA must be gone, not just disabled.
  await expect(page.getByRole('link', { name: 'Deploy to AWS' })).toHaveCount(0);
});

// ── Pre-relay lifecycle: per-deployment stack names, launch signal, retry ────

test('two deployments of the same application in the same region prefill different stack names', async ({
  page,
  request,
}) => {
  const seeded = await seedInstall(request);

  // A second deployment of the SAME application into the SAME region — the
  // exact collision case: a fixed bootstrap stack name would make the
  // second install fail with "stack already exists" in one AWS account.
  const secondDeployment = await request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: seeded.applicationId, customerId: seeded.customerId, region: 'us-east-1' },
  });
  expect(secondDeployment.ok()).toBeTruthy();
  const second = (await secondDeployment.json()) as { installLinkId: string };

  await page.goto(`/install/${seeded.installLinkId}`);
  const firstHref = await page.getByRole('link', { name: 'Deploy to AWS' }).getAttribute('href');

  await page.goto(`/install/${second.installLinkId}`);
  const secondHref = await page.getByRole('link', { name: 'Deploy to AWS' }).getAttribute('href');

  expect(firstHref).toContain('stackName=deployz-bootstrap-analytics-cloud-');
  expect(secondHref).toContain('stackName=deployz-bootstrap-analytics-cloud-');
  // The short deployment-id suffix is what keeps two installs of the same
  // app from colliding on one fixed stack name in one AWS account.
  expect(firstHref).not.toBe(secondHref);
  // The prefilled name still carries no credential.
  expect(firstHref).not.toMatch(/token|secret|credential/i);
});

test('pressing Deploy to AWS reports the launch and the page then waits for the connector', async ({
  page,
  request,
}) => {
  const { installLinkId, deploymentId } = await seedInstall(request);

  // Keep the browser on the install page: the real destination is the AWS
  // console, which the harness must not navigate to. The glob matches the
  // region-prefixed console host (`us-east-1.console.aws.amazon.com`).
  let launched = false;
  await page.route('**.console.aws.amazon.com/**', async (route) => {
    launched = true;
    await route.abort();
  });

  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('link', { name: 'Deploy to AWS' })).toBeVisible();
  await page.getByRole('link', { name: 'Deploy to AWS' }).click();
  await expect
    .poll(async () => launched, { timeout: 10_000 })
    .toBe(true);

  const install = (await request.get(`${API_URL}/api/install/${installLinkId}`).then((r) =>
    r.json(),
  )) as { waitingForRelay: boolean; relayStuck: boolean; deploymentState: string };
  expect(install.waitingForRelay).toBe(true);
  expect(install.relayStuck).toBe(false);
  expect(install.deploymentState).toBe('WAITING_FOR_RELAY');

  await page.goto(`/install/${installLinkId}`);
  await expect(
    page.getByText('Deployz is connecting to your AWS account…'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open AWS CloudFormation' })).toBeVisible();
  await expect(page.getByText(deploymentId.slice(0, 8))).toBeVisible();

  // The launch signal is idempotent — reporting it again keeps the waiting
  // state instead of starting a new attempt.
  const relaunched = await request.post(`${API_URL}/api/install/${installLinkId}/launched`, {
    data: {},
  });
  expect(relaunched.status()).toBe(200);
});

test('a customer retry starts a fresh attempt with a fresh stack name and code', async ({
  page,
  request,
}) => {
  const { installLinkId } = await seedInstall(request);

  await request.post(`${API_URL}/api/install/${installLinkId}/launched`, { data: {} });
  const before = (await request.get(`${API_URL}/api/install/${installLinkId}`).then((r) =>
    r.json(),
  )) as { bootstrapStackName: string; quickCreateUrl: string | null };

  const retry = await request.post(`${API_URL}/api/install/${installLinkId}/retry`, { data: {} });
  expect(retry.status()).toBe(200);
  const attempt = (await retry.json()) as {
    state: string;
    attemptNumber: number;
    bootstrapStackName: string;
  };
  expect(attempt.state).toBe('NOT_INSTALLED');
  expect(attempt.attemptNumber).toBe(1);
  expect(attempt.bootstrapStackName).not.toBe(before.bootstrapStackName);
  expect(attempt.bootstrapStackName).toContain('-r1');

  // The install page hands the customer the fresh link, prefilled with the
  // new stack name no leftover from the first attempt can block.
  await page.goto(`/install/${installLinkId}`);
  const href = await page.getByRole('link', { name: 'Deploy to AWS' }).getAttribute('href');
  expect(href).toContain(`stackName=${encodeURIComponent(attempt.bootstrapStackName)}`);
});

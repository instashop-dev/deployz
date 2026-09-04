import { expect, test, type Page } from '@playwright/test';

// §19/§20 fix-instructions flow, against the REAL API (GITHUB_FIXTURE_MODE +
// AI_FIXTURE_MODE — see playwright.config.ts). deployz-demo/monorepo analyses
// as ALMOST_READY with exactly one required finding ('Give Deployz a way to
// check your app', id health-check — see packages/analysis/src/
// readiness-report.ts), so it is the fixture that best exercises "Generate
// fix instructions" → the consolidated coding-agent document → "Re-analyse
// application" without the dialog's generation ever resolving the finding
// itself.

async function signUp(page: Page): Promise<void> {
  const email = `e2e-fix-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Fix User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('generating fix instructions never resolves findings — re-analysis recomputes the same result', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await signUp(page);
  await page.goto('/dashboard/applications');

  // Select the monorepo fixture repo specifically — the whole row is the
  // Select control (RepositoryRow in apps/web/src/components/
  // repository-picker.tsx).
  await page.getByTestId('repo-row-deployz-demo/monorepo').getByRole('button').click();
  await page.waitForURL(/\/dashboard\/applications\/[0-9a-f-]{36}$/);

  // ── The readiness verdict: ALMOST_READY, one required change. ──────────────
  await expect(page.getByTestId('readiness-verdict')).toBeVisible();
  await expect(page.getByText('1 change needed before deployment')).toBeVisible();
  await expect(page.getByTestId('readiness-summary')).toContainText(
    'Fix the item below before deploying.',
  );

  // The finding is visible with its plain-English line; the technical detail
  // stays hidden until "How to fix" is opened.
  const finding = page.getByTestId('readiness-finding-health-check');
  await expect(finding).toBeVisible();
  await expect(
    finding.getByText('Deployz needs a reliable way to know when your app is running and ready.'),
  ).toBeVisible();
  const technicalDetail = finding.getByText(
    'No health endpoint or container health check was found',
    { exact: false },
  );
  await expect(technicalDetail).toBeHidden();
  await finding.getByText('How to fix').click();
  await expect(technicalDetail).toBeVisible();

  // ── Generate fix instructions. ──────────────────────────────────────────────
  await page.getByTestId('generate-fix-instructions').click();
  const dialog = page.getByTestId('fix-instructions-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('coding agent', { exact: false }).first()).toBeVisible();

  const content = page.getByTestId('fix-instructions-content');
  await expect(content).toContainText('Prepare this repository for deployment through Deployz');
  await expect(content).toContainText('Do not assume Deployz findings are correct');

  // ── Copy instructions to the clipboard. ─────────────────────────────────────
  await page.getByTestId('fix-instructions-copy').click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('Deployz');

  // ── Re-analyse from the dialog: it closes, and re-analysis recomputes the
  // same ALMOST_READY / 1-required-change result from the repository — the
  // generation step never resolved the finding itself. ────────────────────────
  await page.getByTestId('fix-instructions-reanalyse').click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText('1 change needed before deployment')).toBeVisible();
  await expect(page.getByTestId('readiness-summary')).toContainText(
    'Fix the item below before deploying.',
  );
});

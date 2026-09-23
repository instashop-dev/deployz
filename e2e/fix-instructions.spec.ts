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
  await expect(page.getByTestId('application-state-heading')).toHaveText('1 change required before you can deploy');

  // The readiness table and the finding live on the Configuration tab.
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');
  await expect(page.getByTestId('readiness-table')).toBeVisible();
  await expect(page.getByText('1 change required')).toBeVisible();

  // The finding is a 'health'-category finding, so it folds into the Health
  // check row rather than rendering as its own row
  // (application-configuration.ts) — its plain-English line sits behind that
  // row's info affordance.
  const finding = page.getByTestId('readiness-setting-health');
  await expect(finding).toBeVisible();
  await finding.getByRole('button', { name: /Details for/ }).click();
  await expect(
    page.getByRole('dialog').getByText('Deployz needs a reliable way to know when your app is running and ready.'),
  ).toBeVisible();
  const technicalDetail = finding.getByText(
    'No health endpoint or container health check was found',
    { exact: false },
  );
  // The technical detail now lives behind the fix-instructions dialog.
  await expect(technicalDetail).toHaveCount(0);

  // ── Generate fix instructions. ──────────────────────────────────────────────
  await page.getByTestId('readiness-finding-fix-health-check').click();
  const dialog = page.getByTestId('fix-instructions-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('coding agent', { exact: false }).first()).toBeVisible();

  const content = page.getByTestId('fix-instructions-content');
  await expect(content).toContainText('Fix deployment blockers');
  await expect(content).toContainText('Readiness endpoint missing');
  await expect(content).toContainText('Do not assume Deployz findings are correct');
  await expect(page.getByTestId('fix-instructions-generated')).toContainText('Generated');

  // Regenerate asks for a fresh document; the result still carries the guardrail.
  await page.getByTestId('fix-instructions-regenerate').click();
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

  await expect(page.getByText('1 change required')).toBeVisible();
});

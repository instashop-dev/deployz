import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

// End-to-end coverage for §41/§63 organization & account management: invites,
// role changes, ownership transfer, org switching/deletion, profile/password,
// and account deletion. Every test drives the real browser against the real
// API (Fastify :3001) exactly like auth.spec.ts / shell.spec.ts, and every
// test generates its own fresh emails so it is safe to re-run against the
// shared dev database.

const API_URL = 'http://localhost:3001';
// Throwaway credentials for the accounts these tests create, generated per
// run. Nothing is written down, so there is no credential in the source
// for a scanner to find.
const PASSWORD = crypto.randomUUID();
const NEW_PASSWORD = crypto.randomUUID();

// A mutation followed by router.refresh() re-renders the page on the server.
// On a cold dev-server compile that round-trip comfortably exceeds the 5s
// default expect window, so every post-mutation assertion waits this long.
const REFRESH_TIMEOUT = 15_000;

// The dashboard forms are React CONTROLLED inputs. On a dev server the page
// HTML arrives before its JavaScript hydrates, and a value typed into the
// input before that moment is discarded when React takes over — the submit
// button then stays disabled because its state is still empty. Retry until
// the value sticks. The sign-in/sign-up fields are uncontrolled and need no
// such care.
async function fillControlled(locator: Locator, value: string): Promise<void> {
  await expect(async () => {
    await locator.fill(value);
    await expect(locator).toHaveValue(value);
  }).toPass({ timeout: 15_000 });
}

async function selectControlled(locator: Locator, value: string): Promise<void> {
  await expect(async () => {
    await locator.selectOption(value);
    await expect(locator).toHaveValue(value);
  }).toPass({ timeout: 15_000 });
}

function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

// Mirrors the signup flow proven in auth.spec.ts's first test.
async function signUp(page: Page, name: string, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function currentOrgName(page: Page): Promise<string> {
  const response = await page.request.get(`${API_URL}/api/organization`);
  expect(response.ok()).toBeTruthy();
  const org = (await response.json()) as { name: string };
  return org.name;
}

// Reuses the browser's session cookies (page.request shares them with the
// page, per the task brief) to invite by email through the real form.
async function inviteMember(page: Page, email: string, role: 'admin' | 'member' = 'member'): Promise<void> {
  await page.goto('/dashboard/settings/members');
  await fillControlled(page.getByTestId('invite-email'), email);
  await selectControlled(page.getByTestId('invite-role'), role);
  await page.getByTestId('invite-submit').click();
  // A generous timeout: this waits on the invite POST plus the members
  // page's router.refresh() re-fetch, which can be slow when the dev
  // servers are under load from other tests running concurrently.
  await expect(page.getByTestId('invitation-row').filter({ hasText: email })).toBeVisible({
    timeout: REFRESH_TIMEOUT,
  });
}

async function invitationIdFor(page: Page, email: string): Promise<string> {
  const response = await page.request.get(`${API_URL}/api/organization/invitations`);
  expect(response.ok()).toBeTruthy();
  const { invitations } = (await response.json()) as {
    invitations: Array<{ id: string; email: string }>;
  };
  const invitation = invitations.find((row) => row.email.toLowerCase() === email.toLowerCase());
  if (!invitation) throw new Error(`No pending invitation found for ${email}`);
  return invitation.id;
}

// Drives a brand-new browser context through the invited-user half of the
// invite flow: open the link while signed out, sign up with the invited
// address (the callbackUrl round-trip lands back on the invitation page),
// then accept. Returns the invited user's page, still on /dashboard.
async function acceptInvitationAsNewUser(
  browser: Browser,
  invitationId: string,
  name: string,
  email: string,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/accept-invitation/${invitationId}`);
  await page.getByRole('link', { name: 'Sign up' }).click();
  await page.waitForURL((url) => url.pathname === '/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL((url) => url.pathname === `/accept-invitation/${invitationId}`);
  await page.getByTestId('invitation-accept').click();
  await page.waitForURL('/dashboard');
  return page;
}

// Opens the sidebar org switcher's dropdown so its items can be asserted on.
async function openOrgSwitcher(page: Page): Promise<void> {
  await page.getByTestId('org-switcher-trigger').click();
  await expect(page.getByTestId('org-switcher-item').first()).toBeVisible();
}

test.describe('invitations: invite, accept, duplicates', () => {
  // Journey 1: owner invites, a second browser context accepts as a new
  // user, and both people end up listed on the owner's members page. Proves
  // the invite → signup(callbackUrl) → accept round trip and that accepting
  // switches the invited user's active tenant to the inviting organization.
  test('inviting a new email and accepting lands the invitee in the org, visible to the owner', async ({
    page,
    browser,
  }) => {
    const ownerEmail = uniqueEmail('owner');
    await signUp(page, 'Owner User', ownerEmail);
    const orgName = await currentOrgName(page);

    const inviteeEmail = uniqueEmail('invitee');
    await inviteMember(page, inviteeEmail, 'admin');

    const invitationId = await invitationIdFor(page, inviteeEmail);

    const inviteePage = await acceptInvitationAsNewUser(
      browser,
      invitationId,
      'Invitee User',
      inviteeEmail,
    );
    await expect(inviteePage.getByTestId('org-name')).toHaveText(orgName);

    await page.goto('/dashboard/settings/members');
    await expect(page.getByTestId('member-row')).toHaveCount(2);
    await expect(page.getByTestId('member-row').filter({ hasText: ownerEmail })).toBeVisible();
    await expect(page.getByTestId('member-row').filter({ hasText: inviteeEmail })).toBeVisible();

    await inviteePage.context().close();
  });

  // Journey 2: the server's 409 messages for a still-live duplicate
  // invitation and for inviting someone already in the organization render
  // inline, verbatim, on the invite form.
  test('duplicate invite and inviting an existing member both show the server message inline', async ({
    page,
  }) => {
    const ownerEmail = uniqueEmail('owner');
    await signUp(page, 'Owner User', ownerEmail);

    const inviteeEmail = uniqueEmail('invitee');
    await inviteMember(page, inviteeEmail, 'member');

    // Same email again while the first invitation is still pending. Scoped
    // to a <p role="alert"> because Next.js's route announcer is also an
    // (empty) role=alert element on every page.
    await fillControlled(page.getByTestId('invite-email'), inviteeEmail);
    await page.getByTestId('invite-submit').click();
    await expect(page.locator('p[role="alert"]')).toContainText('already has a pending invitation');

    // The owner's own email is already a member of the organization.
    await fillControlled(page.getByTestId('invite-email'), ownerEmail);
    await page.getByTestId('invite-submit').click();
    await expect(page.locator('p[role="alert"]')).toContainText('already in this organization');
  });
});

test.describe('invitations: resend and revoke', () => {
  // Journey 3: resend refreshes the expiry (and keeps the invitation listed);
  // revoke removes it from the pending list entirely.
  test('resend refreshes the expiry and revoke removes the invitation', async ({ page }) => {
    await signUp(page, 'Owner User', uniqueEmail('owner'));
    const inviteeEmail = uniqueEmail('invitee');
    await inviteMember(page, inviteeEmail, 'member');

    const beforeId = await invitationIdFor(page, inviteeEmail);
    const beforeResponse = await page.request.get(`${API_URL}/api/organization/invitations`);
    const { invitations: before } = (await beforeResponse.json()) as {
      invitations: Array<{ id: string; expiresAt: string }>;
    };
    const beforeExpiry = before.find((row) => row.id === beforeId)!.expiresAt;

    const row = page.getByTestId('invitation-row').filter({ hasText: inviteeEmail });
    const resendResponse = page.waitForResponse(
      (response) => response.url().includes('/resend') && response.request().method() === 'POST',
    );
    await row.getByTestId('invitation-resend').click();
    await resendResponse;
    await expect(row).toBeVisible();

    const afterResponse = await page.request.get(`${API_URL}/api/organization/invitations`);
    const { invitations: after } = (await afterResponse.json()) as {
      invitations: Array<{ id: string; expiresAt: string }>;
    };
    const afterExpiry = after.find((r) => r.id === beforeId)!.expiresAt;
    expect(new Date(afterExpiry).getTime()).toBeGreaterThan(new Date(beforeExpiry).getTime());

    await row.getByTestId('invitation-revoke').click();
    await row.getByTestId('invitation-revoke-confirm').click();
    await expect(
      page.getByTestId('invitation-row').filter({ hasText: inviteeEmail }),
    ).toHaveCount(0, { timeout: REFRESH_TIMEOUT });
  });
});

test.describe('roles and membership management', () => {
  // Journey 4: the owner demotes an admin to member; the demoted member's own
  // members page becomes read-only (no actions, no invite form) and they can
  // no longer rename the organization.
  test('demoting an admin to member makes their own team screen read-only', async ({ page, browser }) => {
    await signUp(page, 'Owner User', uniqueEmail('owner'));
    const orgName = await currentOrgName(page);
    const memberEmail = uniqueEmail('admin-to-member');
    await inviteMember(page, memberEmail, 'admin');
    const invitationId = await invitationIdFor(page, memberEmail);
    const memberPage = await acceptInvitationAsNewUser(browser, invitationId, 'Demoted User', memberEmail);

    await page.goto('/dashboard/settings/members');
    const memberRow = page.getByTestId('member-row').filter({ hasText: memberEmail });
    await selectControlled(memberRow.getByTestId('member-role-select'), 'member');
    await expect(memberRow.getByTestId('member-role-select')).toHaveValue('member');

    await memberPage.goto('/dashboard/settings/members');
    await expect(memberPage.getByTestId('invite-email')).toHaveCount(0);
    await expect(memberPage.getByTestId('member-role-select')).toHaveCount(0);
    await expect(memberPage.getByTestId('member-remove')).toHaveCount(0);
    await expect(memberPage.getByTestId('transfer-ownership')).toHaveCount(0);

    await memberPage.goto('/dashboard/settings');
    await expect(memberPage.getByRole('textbox', { name: 'Organization name' })).toHaveCount(0);
    // Scoped to <main> because the sidebar's org-switcher trigger also shows
    // the same org name text.
    await expect(memberPage.getByRole('main').getByText(orgName, { exact: true })).toBeVisible();
    await expect(
      memberPage.getByText('Only an owner or admin can rename the organization.'),
    ).toBeVisible();

    await memberPage.context().close();
  });

  // Journey 5: the owner removes a member; in the removed user's own
  // browser context, that organization no longer appears in the switcher.
  test('removing a member drops the organization from their switcher', async ({ page, browser }) => {
    await signUp(page, 'Owner User', uniqueEmail('owner'));
    const orgName = await currentOrgName(page);
    const memberEmail = uniqueEmail('removed');
    await inviteMember(page, memberEmail, 'member');
    const invitationId = await invitationIdFor(page, memberEmail);
    const memberPage = await acceptInvitationAsNewUser(browser, invitationId, 'Removed User', memberEmail);

    await page.goto('/dashboard/settings/members');
    const memberRow = page.getByTestId('member-row').filter({ hasText: memberEmail });
    await memberRow.getByTestId('member-remove').click();
    await memberRow.getByTestId('member-remove-confirm').click();
    await expect(
      page.getByTestId('member-row').filter({ hasText: memberEmail }),
    ).toHaveCount(0, { timeout: REFRESH_TIMEOUT });

    await memberPage.goto('/dashboard');
    await openOrgSwitcher(memberPage);
    await expect(memberPage.getByTestId('org-switcher-item').filter({ hasText: orgName })).toHaveCount(0);

    await memberPage.context().close();
  });

  // Journey 6: a non-owner leaves through the members page and no longer
  // sees the organization in their own switcher afterward.
  test('a member can leave the organization and it disappears from their switcher', async ({
    page,
    browser,
  }) => {
    await signUp(page, 'Owner User', uniqueEmail('owner'));
    const orgName = await currentOrgName(page);
    const memberEmail = uniqueEmail('leaver');
    await inviteMember(page, memberEmail, 'member');
    const invitationId = await invitationIdFor(page, memberEmail);
    const memberPage = await acceptInvitationAsNewUser(browser, invitationId, 'Leaver User', memberEmail);

    await memberPage.goto('/dashboard/settings/members');
    await memberPage.getByTestId('leave-organization').click();
    await memberPage.getByTestId('leave-organization-confirm').click();
    await memberPage.waitForURL('/dashboard');

    await openOrgSwitcher(memberPage);
    await expect(memberPage.getByTestId('org-switcher-item').filter({ hasText: orgName })).toHaveCount(0);

    await memberPage.context().close();
  });

  // Journey 7: the owner has no role/remove controls on their own row, and
  // the "Leave organization" card never renders for an owner.
  test('the owner has no self-management controls and no leave option', async ({ page }) => {
    await signUp(page, 'Owner User', uniqueEmail('owner'));
    await page.goto('/dashboard/settings/members');

    const ownRow = page.getByTestId('member-row').filter({ hasText: '(You)' });
    await expect(ownRow).toBeVisible();
    await expect(ownRow.getByTestId('member-role-select')).toHaveCount(0);
    await expect(ownRow.getByTestId('member-remove')).toHaveCount(0);
    await expect(ownRow.getByTestId('transfer-ownership')).toHaveCount(0);

    await expect(page.getByRole('heading', { name: 'Leave organization' })).toHaveCount(0);
    await expect(page.getByTestId('leave-organization')).toHaveCount(0);
  });

  // Journey 8: transferring ownership flips both roles — the former owner
  // becomes admin, the promoted member becomes owner.
  test('transferring ownership swaps roles between the two members', async ({ page, browser }) => {
    const ownerEmail = uniqueEmail('owner');
    await signUp(page, 'Owner User', ownerEmail);
    const memberEmail = uniqueEmail('promoted');
    await inviteMember(page, memberEmail, 'member');
    const invitationId = await invitationIdFor(page, memberEmail);
    const memberPage = await acceptInvitationAsNewUser(browser, invitationId, 'Promoted User', memberEmail);

    await page.goto('/dashboard/settings/members');
    const memberRow = page.getByTestId('member-row').filter({ hasText: memberEmail });
    await memberRow.getByTestId('transfer-ownership').click();
    await memberRow.getByTestId('transfer-ownership-confirm').click();
    await expect(
      page.getByTestId('member-row').filter({ hasText: memberEmail }),
    ).toContainText('Owner', { timeout: REFRESH_TIMEOUT });

    const membersResponse = await page.request.get(`${API_URL}/api/organization/members`);
    const { members } = (await membersResponse.json()) as {
      members: Array<{ email: string; role: string }>;
    };
    expect(members.find((m) => m.email.toLowerCase() === ownerEmail.toLowerCase())?.role).toBe('admin');
    expect(members.find((m) => m.email.toLowerCase() === memberEmail.toLowerCase())?.role).toBe('owner');

    await memberPage.context().close();
  });
});

test.describe('organization switching and deletion', () => {
  // Journey 9: creating a second organization through the switcher switches
  // into it immediately, and switching back through the dropdown updates the
  // sidebar name.
  test('creating and switching organizations updates the sidebar name', async ({ page }) => {
    await signUp(page, 'Switcher User', uniqueEmail('switcher'));
    const firstOrgName = await currentOrgName(page);

    await openOrgSwitcher(page);
    await page.getByTestId('org-switcher-create').click();
    await page.waitForURL('/organizations/new');

    const secondOrgName = `Second Org ${crypto.randomUUID().slice(0, 8)}`;
    await fillControlled(page.getByTestId('create-organization-name'), secondOrgName);
    await page.getByTestId('create-organization-submit').click();
    await page.waitForURL('/dashboard');
    await expect(page.getByTestId('org-name')).toHaveText(secondOrgName);

    await openOrgSwitcher(page);
    await page.getByTestId('org-switcher-item').filter({ hasText: firstOrgName }).click();
    await expect(page.getByTestId('org-name')).toHaveText(firstOrgName);
  });

  // Journey 10: the delete-organization button stays disabled until the
  // exact name is typed, and after deletion the user lands on their
  // remaining organization.
  test('deleting an organization requires the exact name and falls back to the remaining org', async ({
    page,
  }) => {
    await signUp(page, 'Deleter User', uniqueEmail('deleter'));
    const personalOrgName = await currentOrgName(page);

    const secondOrgName = `Doomed Org ${crypto.randomUUID().slice(0, 8)}`;
    await page.goto('/organizations/new');
    await fillControlled(page.getByTestId('create-organization-name'), secondOrgName);
    await page.getByTestId('create-organization-submit').click();
    await page.waitForURL('/dashboard');

    await page.goto('/dashboard/settings');
    await expect(page.getByTestId('delete-organization-submit')).toBeDisabled();
    await fillControlled(page.getByTestId('delete-organization-confirm'), secondOrgName.slice(0, -1));
    await expect(page.getByTestId('delete-organization-submit')).toBeDisabled();
    await fillControlled(page.getByTestId('delete-organization-confirm'), secondOrgName);
    await expect(page.getByTestId('delete-organization-submit')).toBeEnabled();

    await page.getByTestId('delete-organization-submit').click();
    await page.waitForURL('/dashboard');
    await expect(page.getByTestId('org-name')).toHaveText(personalOrgName);
  });
});

test.describe('profile and password', () => {
  // Journey 11: renaming the display name shows up in the top bar; a
  // mismatched password confirmation is caught inline; a real password
  // change succeeds and the new password works on a fresh sign-in.
  test('profile name updates the top bar; password change validates and takes effect', async ({ page }) => {
    const email = uniqueEmail('profile');
    await signUp(page, 'Original Name', email);

    await page.goto('/dashboard/settings/profile');
    const newName = `Renamed User ${crypto.randomUUID().slice(0, 6)}`;
    await fillControlled(page.getByTestId('profile-name'), newName);
    await page.getByTestId('profile-save').click();
    await expect(page.getByRole('status')).toHaveText('Saved.');
    await expect(page.getByTestId('user-menu-trigger')).toContainText(newName, {
      timeout: REFRESH_TIMEOUT,
    });

    await fillControlled(page.getByTestId('password-current'), PASSWORD);
    await fillControlled(page.getByTestId('password-new'), NEW_PASSWORD);
    await fillControlled(page.getByTestId('password-confirm'), `${NEW_PASSWORD}-mismatch`);
    await page.getByTestId('password-save').click();
    await expect(page.locator('p[role="alert"]')).toContainText('The new passwords do not match.');

    await fillControlled(page.getByTestId('password-current'), PASSWORD);
    await fillControlled(page.getByTestId('password-new'), NEW_PASSWORD);
    await fillControlled(page.getByTestId('password-confirm'), NEW_PASSWORD);
    await page.getByTestId('password-save').click();
    // Scoped to the password form's own status text — the profile form's
    // "Saved." status from earlier in this test is still on the page too.
    await expect(page.getByTestId('password-save').locator('..').getByRole('status')).toContainText(
      'Password changed.',
    );

    await page.getByTestId('user-menu-trigger').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL('/sign-in');

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('/dashboard');
  });
});

test.describe('account deletion', () => {
  // Journey 12a: an owner of an organization with other members cannot
  // delete their account until ownership is transferred — the server's
  // 409 message renders inline instead of the request succeeding.
  test('deleting an account while owning a shared organization is blocked inline', async ({
    page,
    browser,
  }) => {
    const ownerEmail = uniqueEmail('owner-block');
    await signUp(page, 'Owner User', ownerEmail);
    const memberEmail = uniqueEmail('member-block');
    await inviteMember(page, memberEmail, 'member');
    const invitationId = await invitationIdFor(page, memberEmail);
    const memberPage = await acceptInvitationAsNewUser(browser, invitationId, 'Member User', memberEmail);

    await page.goto('/dashboard/settings/profile');
    await fillControlled(page.getByTestId('delete-account-confirm'), ownerEmail);
    await page.getByTestId('delete-account-submit').click();
    await expect(page.locator('p[role="alert"]')).toContainText('Transfer ownership of');

    await memberPage.context().close();
  });

  // Journey 12b: a solo user (sole member of their own organization) can
  // delete their account outright, is bounced to /sign-in, and the old
  // password no longer works.
  test('a solo user can delete their account and the old password stops working', async ({ page }) => {
    const email = uniqueEmail('solo-delete');
    await signUp(page, 'Solo User', email);

    await page.goto('/dashboard/settings/profile');
    await fillControlled(page.getByTestId('delete-account-confirm'), email);
    await page.getByTestId('delete-account-submit').click();
    await page.waitForURL('/sign-in');

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('p[role="alert"]')).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe('invitation link edge cases', () => {
  // Journey 13a: an invitation id that does not exist renders the "not
  // valid" card rather than erroring.
  test('an unknown invitation id renders the not-valid card', async ({ page }) => {
    await page.goto(`/accept-invitation/${crypto.randomUUID()}`);
    await expect(page.getByRole('heading', { name: 'This invitation link is not valid' })).toBeVisible();
  });

  // Journey 13b: opening the invitation link while signed in as a different
  // user explains the email mismatch and offers a sign-out action instead of
  // a broken accept button.
  test('opening an invitation as the wrong signed-in user explains the mismatch', async ({ page }) => {
    await signUp(page, 'Owner User', uniqueEmail('owner-mismatch'));
    const orgName = await currentOrgName(page);
    const inviteeEmail = uniqueEmail('invitee-mismatch');
    await inviteMember(page, inviteeEmail, 'member');
    const invitationId = await invitationIdFor(page, inviteeEmail);

    // Still signed in as the owner, whose email differs from the invite.
    await page.goto(`/accept-invitation/${invitationId}`);
    await expect(page.getByRole('heading', { name: `Join ${orgName}` })).toBeVisible();
    await expect(page.getByText('You are signed in as')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });
});

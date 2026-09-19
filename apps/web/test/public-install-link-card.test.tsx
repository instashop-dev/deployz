// @vitest-environment jsdom

import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PublicInstallLinkCreated,
  PublicInstallLinkView,
} from '../src/lib/public-install-links';
import { ApiRequestError } from '../src/lib/api-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const linkMocks = vi.hoisted(() => ({
  createPublicInstallLink: vi.fn(),
  fetchPublicInstallLinks: vi.fn(),
  setPublicInstallLinkEnabled: vi.fn(),
  revokePublicInstallLink: vi.fn(),
  regeneratePublicInstallLink: vi.fn(),
}));

vi.mock('../src/lib/public-install-links', () => ({
  ...linkMocks,
  publicInstallHtmlSnippet: (url: string) => `<a href="${url}">Deploy to AWS with Deployz</a>`,
  publicInstallLinkStatusBadge: (status: string) => {
    if (status === 'active') return { label: 'Active', variant: 'success' as const };
    if (status === 'disabled') return { label: 'Disabled', variant: 'secondary' as const };
    return { label: 'Revoked', variant: 'secondary' as const };
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const { PublicInstallLinkCard } = await import('../src/components/public-install-link-card');

const APP_ID = 'app-1';

function activeLink(overrides: Partial<PublicInstallLinkView> = {}): PublicInstallLinkView {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    url: 'https://app.deployz.dev/install/11111111-1111-1111-1111-111111111111',
    status: 'active',
    createdAt: '2026-09-04T00:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

function createdLink(overrides: Partial<PublicInstallLinkCreated> = {}): PublicInstallLinkCreated {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    url: 'https://app.deployz.dev/install/11111111-1111-1111-1111-111111111111',
    htmlSnippet: '<a href="https://app.deployz.dev/install/11111111-1111-1111-1111-111111111111">Deploy to AWS with Deployz</a>',
    enabled: true,
    createdAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function flushPromises(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function renderCard(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PublicInstallLinkCard applicationId={APP_ID} />);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  linkMocks.createPublicInstallLink.mockReset();
  linkMocks.fetchPublicInstallLinks.mockReset();
  linkMocks.setPublicInstallLinkEnabled.mockReset();
  linkMocks.revokePublicInstallLink.mockReset();
  linkMocks.regeneratePublicInstallLink.mockReset();
});

describe('PublicInstallLinkCard', () => {
  it('renders the loading card while its data is being fetched', () => {
    linkMocks.fetchPublicInstallLinks.mockReturnValue(new Promise(() => {}));
    const { window } = new JSDOM(renderToString(<PublicInstallLinkCard applicationId={APP_ID} />));
    const doc = window.document;

    expect(doc.querySelector('[data-testid="public-install-link-card"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="public-install-link-loading"]')).not.toBeNull();
  });

  it('shows the empty state, creates a link, and displays the active link', async () => {
    linkMocks.fetchPublicInstallLinks
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([activeLink()]);
    linkMocks.createPublicInstallLink.mockResolvedValue(createdLink());

    renderCard();
    await act(async () => Promise.resolve());

    expect(document.body.textContent).toContain('Create public install link');

    const createButton = document.querySelector('[data-testid="public-install-link-create"]') as HTMLButtonElement;
    expect(createButton).not.toBeNull();

    await act(async () => {
      click(createButton);
    });

    await act(async () => Promise.resolve());

    expect(document.querySelector('[data-testid="public-install-link-active"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="public-install-link-url"]')?.textContent).toBe(activeLink().url);
    expect(document.querySelector('[data-testid="public-install-link-copy-url"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="public-install-link-copy-snippet"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="public-install-link-preview"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="public-install-link-switch"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="public-install-link-regenerate"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="public-install-link-revoke"]')).not.toBeNull();
  });

  it('copies the direct URL and the HTML snippet to the clipboard', async () => {
    linkMocks.fetchPublicInstallLinks.mockResolvedValue([activeLink()]);

    renderCard();
    await act(async () => Promise.resolve());

    const copyUrlButton = document.querySelector('[data-testid="public-install-link-copy-url"]') as HTMLButtonElement;
    const copySnippetButton = document.querySelector('[data-testid="public-install-link-copy-snippet"]') as HTMLButtonElement;

    await act(async () => {
      click(copyUrlButton);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(activeLink().url);

    await act(async () => {
      click(copySnippetButton);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '<a href="https://app.deployz.dev/install/11111111-1111-1111-1111-111111111111">Deploy to AWS with Deployz</a>',
    );
  });

  it('toggles the link enabled and disabled', async () => {
    linkMocks.fetchPublicInstallLinks
      .mockResolvedValueOnce([activeLink()])
      .mockResolvedValueOnce([activeLink({ status: 'disabled' })])
      .mockResolvedValueOnce([activeLink()]);
    linkMocks.setPublicInstallLinkEnabled.mockResolvedValue({ link: activeLink({ status: 'disabled' }) });

    renderCard();
    await act(async () => Promise.resolve());

    const switchControl = document.querySelector('[data-testid="public-install-link-switch"]') as HTMLElement;
    expect(switchControl).not.toBeNull();
    expect(document.body.textContent).toContain('Enabled');

    await act(async () => {
      click(switchControl);
    });

    expect(linkMocks.setPublicInstallLinkEnabled).toHaveBeenCalledWith(activeLink().id, false);
    await act(async () => Promise.resolve());

    expect(document.body.textContent).toContain('Disabled');

    linkMocks.setPublicInstallLinkEnabled.mockResolvedValue({ link: activeLink() });

    await act(async () => {
      click(switchControl);
    });

    expect(linkMocks.setPublicInstallLinkEnabled).toHaveBeenCalledWith(activeLink().id, true);
  });

  it('revokes the link after confirming the dialog', async () => {
    linkMocks.fetchPublicInstallLinks
      .mockResolvedValueOnce([activeLink()])
      .mockResolvedValueOnce([]);
    linkMocks.revokePublicInstallLink.mockResolvedValue({ link: activeLink({ status: 'revoked' }) });

    renderCard();
    await act(async () => Promise.resolve());

    const revokeButton = document.querySelector('[data-testid="public-install-link-revoke"]') as HTMLButtonElement;
    await act(async () => {
      click(revokeButton);
    });

    expect(document.body.textContent).toContain('Revoke this public install link?');
    expect(document.body.textContent).toContain('No AWS resources are destroyed');

    const confirmButton = document.querySelector('[data-testid="public-install-link-revoke-confirm"]') as HTMLButtonElement;
    await act(async () => {
      click(confirmButton);
    });

    expect(linkMocks.revokePublicInstallLink).toHaveBeenCalledWith(activeLink().id);
    await act(async () => Promise.resolve());

    expect(document.querySelector('[data-testid="public-install-link-empty"]')).not.toBeNull();
  });

  it('regenerates the link after confirming the dialog and swaps the id', async () => {
    const oldLink = activeLink();
    const newLink = activeLink({
      id: '22222222-2222-2222-2222-222222222222',
      url: 'https://app.deployz.dev/install/22222222-2222-2222-2222-222222222222',
    });

    linkMocks.fetchPublicInstallLinks
      .mockResolvedValueOnce([oldLink])
      .mockResolvedValueOnce([newLink]);
    linkMocks.regeneratePublicInstallLink.mockResolvedValue(createdLink(newLink));

    renderCard();
    await act(async () => Promise.resolve());

    const regenerateButton = document.querySelector('[data-testid="public-install-link-regenerate"]') as HTMLButtonElement;
    await act(async () => {
      click(regenerateButton);
    });

    expect(document.body.textContent).toContain('Regenerate this public install link?');
    expect(document.body.textContent).toContain('old link stops working');

    const confirmButton = document.querySelector('[data-testid="public-install-link-regenerate-confirm"]') as HTMLButtonElement;
    await act(async () => {
      click(confirmButton);
    });

    expect(linkMocks.regeneratePublicInstallLink).toHaveBeenCalledWith(oldLink.id);
    await act(async () => Promise.resolve());

    const url = document.querySelector('[data-testid="public-install-link-url"]') as HTMLElement;
    expect(url.textContent).toBe(newLink.url);
  });

  it('shows the generic error when release creation fails', async () => {
    linkMocks.fetchPublicInstallLinks.mockResolvedValue([]);
    linkMocks.createPublicInstallLink.mockRejectedValue(
      new ApiRequestError('RELEASE_NOT_PUBLISHED', 'Release not published'),
    );

    renderCard();
    await act(async () => Promise.resolve());

    const createButton = document.querySelector('[data-testid="public-install-link-create"]') as HTMLButtonElement;
    await act(async () => {
      click(createButton);
    });
    await act(async () => Promise.resolve());

    const error = document.querySelector('[data-testid="public-install-link-error"]') as HTMLElement;
    expect(error.textContent).toContain('Release not published');
    expect(error.textContent).not.toContain('Publish a release before');
  });

  it('shows the new loading text while creating the release and link', async () => {
    let resolvePromise!: (value: PublicInstallLinkCreated) => void;
    const deferred = new Promise<PublicInstallLinkCreated>((resolve) => { resolvePromise = resolve; });
    linkMocks.fetchPublicInstallLinks.mockResolvedValueOnce([]);
    linkMocks.createPublicInstallLink.mockReturnValue(deferred);

    renderCard();
    await act(async () => Promise.resolve());

    const createButton = document.querySelector('[data-testid="public-install-link-create"]') as HTMLButtonElement;
    await act(async () => {
      click(createButton);
    });

    expect(document.body.textContent).toContain('Preparing application for deployment…');
    expect(createButton.disabled).toBe(true);

    // Resolve the create, then mock the refresh call.
    linkMocks.fetchPublicInstallLinks.mockResolvedValueOnce([activeLink()]);
    resolvePromise!(createdLink());
    await flushPromises();

    expect(document.querySelector('[data-testid="public-install-link-active"]')).not.toBeNull();
  });

  it('shows the existing live link when a create conflict occurs', async () => {
    linkMocks.fetchPublicInstallLinks.mockResolvedValueOnce([]).mockResolvedValueOnce([activeLink()]);
    linkMocks.createPublicInstallLink.mockRejectedValue(
      new ApiRequestError('PUBLIC_INSTALL_LINK_EXISTS', 'Link exists'),
    );

    renderCard();
    await act(async () => Promise.resolve());

    const createButton = document.querySelector('[data-testid="public-install-link-create"]') as HTMLButtonElement;
    await act(async () => {
      click(createButton);
    });
    await flushPromises();

    expect(document.querySelector('[data-testid="public-install-link-active"]')).not.toBeNull();
  });
});

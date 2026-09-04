import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DeployLinkCard, DeployLinkList } from '../src/components/deploy-link-card';
import {
  deployLinkStatusBadge,
  deployLinkUrl,
  type DeployLinkView,
} from '../src/lib/deploy-links';

/**
 * Component tests for the vendor Deploy to AWS card (Deploy Links Phase 2).
 *
 * The card is rendered with react-dom/server and parsed with jsdom so we can
 * assert on the visible states without a browser. Effects never run in
 * renderToString, so each state is reached through props: the loading state is
 * the container's initial render, and the container renders the loading card
 * until its applications fetch resolves.
 */

function link(overrides: Partial<DeployLinkView> = {}): DeployLinkView {
  return {
    id: 'b7e2a91c-1f3a-4c5d-8e9f-0a1b2c3d4e5f',
    customerId: 'cust-1',
    applicationId: 'app-1',
    applicationName: 'Acme Analytics',
    deploymentId: 'dep-1',
    deploymentState: 'NOT_INSTALLED',
    region: 'us-east-1',
    status: 'active',
    expiresAt: '2026-10-04T00:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('DeployLinkCard container', () => {
  it('renders the loading card while its data is being fetched', () => {
    const { window } = new JSDOM(renderToString(<DeployLinkCard customerId="cust-1" />));
    const doc = window.document;

    expect(doc.querySelector('[data-testid="deploy-link-card"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="deploy-link-loading"]')).not.toBeNull();
  });
});

describe('deployLinkUrl', () => {
  it('builds the hosted customer URL with the secret in the query', () => {
    expect(deployLinkUrl('link-1', 'tok', 'https://app.deployz.dev')).toBe(
      'https://app.deployz.dev/deploy/link-1?token=tok',
    );
  });
});

describe('deployLinkStatusBadge', () => {
  it('maps each status to a label and a badge variant', () => {
    expect(deployLinkStatusBadge('active')).toEqual({ label: 'Active', variant: 'default' });
    expect(deployLinkStatusBadge('expired')).toEqual({ label: 'Expired', variant: 'secondary' });
    expect(deployLinkStatusBadge('revoked')).toEqual({ label: 'Revoked', variant: 'outline' });
  });
});

describe('DeployLinkList', () => {
  const noop = (): void => undefined;

  function renderList(
    links: DeployLinkView[],
    revealed: { linkId: string; url: string } | null = null,
  ): Document {
    const html = renderToString(
      <DeployLinkList
        links={links}
        revealed={revealed}
        pending="idle"
        onRevoke={noop}
        onRegenerate={noop}
      />,
    );
    const { window } = new JSDOM(html);
    return window.document;
  }

  it('shows the newest active link with its copyable URL and the shown-once note', () => {
    const doc = renderList([link()], { linkId: link().id, url: 'https://app.deployz.dev/deploy/l?token=t' });

    expect(doc.querySelector('[data-testid="deploy-link-url"]')?.textContent).toBe(
      'https://app.deployz.dev/deploy/l?token=t',
    );
    expect(doc.querySelector('[data-testid="deploy-link-copy"]')).not.toBeNull();
    expect(doc.body.textContent).toContain('shown only once');
    expect(doc.querySelector('[data-testid="deploy-link-regenerate"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="deploy-link-revoke"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="deploy-link-status-active"]')?.textContent).toBe(
      'Active',
    );
  });

  it('hides the copy action for an active link whose secret is not in this session', () => {
    const doc = renderList([link({ deploymentState: 'WAITING_FOR_RELAY' })]);

    expect(doc.querySelector('[data-testid="deploy-link-copy"]')).toBeNull();
    expect(doc.querySelector('[data-testid="deploy-link-url"]')).toBeNull();
    expect(doc.body.textContent).toContain('Generate a new one');
    expect(doc.querySelector('[data-testid="deploy-link-revoke"]')).not.toBeNull();
  });

  it('offers regenerate only while the deployment has not started', () => {
    const doc = renderList([link({ deploymentState: 'INSTALLING' })]);

    expect(doc.querySelector('[data-testid="deploy-link-regenerate"]')).toBeNull();
    expect(doc.querySelector('[data-testid="deploy-link-revoke"]')).not.toBeNull();
  });

  it('marks a revoked link and offers no revoke or copy action', () => {
    const doc = renderList([
      link({ status: 'revoked', revokedAt: '2026-09-04T01:00:00.000Z' }),
    ]);

    expect(doc.querySelector('[data-testid="deploy-link-status-revoked"]')?.textContent).toBe(
      'Revoked',
    );
    expect(doc.querySelector('[data-testid="deploy-link-revoke"]')).toBeNull();
    expect(doc.querySelector('[data-testid="deploy-link-copy"]')).toBeNull();
  });

  it('marks an expired link', () => {
    const doc = renderList([
      link({
        status: 'expired',
        expiresAt: '2026-08-01T00:00:00.000Z',
        deploymentState: 'NOT_INSTALLED',
      }),
    ]);

    expect(doc.querySelector('[data-testid="deploy-link-status-expired"]')?.textContent).toBe(
      'Expired',
    );
    // Expired links cannot start a deployment, so there is nothing to regenerate.
    expect(doc.querySelector('[data-testid="deploy-link-regenerate"]')).toBeNull();
  });

  it('renders older links as compact rows without a URL field', () => {
    const doc = renderList(
      [
        link(),
        link({
          id: '9c8d7e6f-1a2b-3c4d-5e6f-7a8b9c0d1e2f',
          applicationName: 'Old App',
          status: 'revoked',
          revokedAt: '2026-09-03T00:00:00.000Z',
        }),
      ],
      { linkId: link().id, url: 'https://app.deployz.dev/deploy/l?token=t' },
    );

    expect(doc.querySelectorAll('[data-testid="deploy-link-row"]')).toHaveLength(2);
    expect(doc.querySelectorAll('[data-testid="deploy-link-url"]')).toHaveLength(1);
  });
});

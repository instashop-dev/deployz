import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PreflightSummary } from '../src/components/preflight-summary';
import { preflightPresentation, type PreflightResult } from '../src/lib/preflight';

// AI MVP Phase 5 — the preflight summary: one headline, blocked and
// recommended checks first, passed checks behind a disclosure. Plain words,
// never a percentage, never AWS vocabulary.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;

function result(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return {
    state: 'READY',
    ready: true,
    blockers: [],
    warnings: [],
    checks: [
      { id: 'compatibility', label: 'Supported architecture', status: 'passed', detail: null },
      { id: 'container', label: 'Application build configuration', status: 'passed', detail: 'Dockerfile' },
      { id: 'database', label: 'Database', status: 'passed', detail: 'PostgreSQL — Deployz provides a managed database' },
      { id: 'customer-variables', label: 'Required customer variables', status: 'passed', detail: '1 value provided' },
    ],
    ...overrides,
  };
}

function render(input: PreflightResult): Document {
  const html = renderToString(<PreflightSummary result={input} />);
  return new JSDOM(html).window.document;
}

describe('preflightPresentation', () => {
  it('names each state in plain words', () => {
    expect(preflightPresentation(result())).toMatchObject({ heading: 'Ready to deploy', tone: 'ready' });
    expect(
      preflightPresentation(
        result({ state: 'READY_WITH_WARNINGS', warnings: [{ id: 'health-check', category: 'health', severity: 'warning', message: 'x' }] }),
      ),
    ).toMatchObject({ heading: 'Ready to deploy', tone: 'attention', summary: '1 recommendation — deployment can go ahead.' });
    expect(
      preflightPresentation(
        result({
          state: 'ACTION_REQUIRED',
          ready: false,
          blockers: [
            { id: 'required-env-vars-missing', category: 'configuration', severity: 'error', message: 'x' },
            { id: 'port-missing', category: 'application', severity: 'error', message: 'y' },
          ],
        }),
      ),
    ).toMatchObject({ heading: 'Action required', tone: 'blocked', summary: 'Fix these 2 issues before deployment.' });
    expect(preflightPresentation(result({ state: 'UNSUPPORTED', ready: false }))).toMatchObject({ tone: 'blocked' });
  });
});

describe('PreflightSummary', () => {
  it('shows a ready result with every check behind the open passed list', () => {
    const doc = render(result());
    expect(doc.querySelector('[data-testid="preflight-heading"]')?.textContent).toBe('Ready to deploy');
    expect(doc.querySelector('[data-testid="preflight-attention"]')).toBeNull();
    const passed = doc.querySelector('[data-testid="preflight-passed"]');
    expect(passed?.hasAttribute('open')).toBe(true);
    expect(passed?.textContent).toContain('Passed checks (4)');
    expect(passed?.textContent).toContain('PostgreSQL — Deployz provides a managed database');
    expect(doc.body.textContent).not.toMatch(JARGON);
    expect(doc.body.textContent).not.toMatch(/%/);
  });

  it('lists blocked and recommended checks first and collapses the passed ones', () => {
    const doc = render(
      result({
        state: 'ACTION_REQUIRED',
        ready: false,
        blockers: [{ id: 'required-env-vars-missing', category: 'configuration', severity: 'error', message: 'x' }],
        checks: [
          { id: 'container', label: 'Application build configuration', status: 'passed', detail: 'Dockerfile' },
          { id: 'health', label: 'Health configuration', status: 'warning', detail: 'No dedicated health endpoint detected — Deployz will probe /health' },
          { id: 'customer-variables', label: 'Required customer variables', status: 'blocked', detail: 'Missing: STRIPE_SECRET_KEY' },
        ],
      }),
    );
    expect(doc.querySelector('[data-testid="preflight-heading"]')?.textContent).toBe('Action required');
    const attention = [...doc.querySelectorAll('[data-testid="preflight-attention"] li')].map((li) => li.getAttribute('data-testid'));
    expect(attention).toEqual(['preflight-check-customer-variables', 'preflight-check-health']);
    expect(doc.querySelector('[data-testid="preflight-check-customer-variables"]')?.textContent).toContain('Missing: STRIPE_SECRET_KEY');
    expect(doc.querySelector('[data-testid="preflight-check-customer-variables"]')?.textContent).toContain('Fix before deploying');
    expect(doc.querySelector('[data-testid="preflight-passed"]')?.hasAttribute('open')).toBe(false);
  });
});

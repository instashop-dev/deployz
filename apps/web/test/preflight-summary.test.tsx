import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PreflightSummary } from '../src/components/preflight-summary';
import { preflightPresentation, type PreflightResult } from '../src/lib/preflight';

// AI MVP Phase 5 — the preflight summary: one status line, blocked and
// recommended checks under it, passed checks behind "View details". Plain
// words, never a percentage, never AWS vocabulary.

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
  it('names each state in one plain line', () => {
    expect(preflightPresentation(result(), 11)).toEqual({ heading: '11 checks passed', tone: 'ready' });
    expect(preflightPresentation(result(), 1)).toEqual({ heading: '1 check passed', tone: 'ready' });
    expect(
      preflightPresentation(
        result({ state: 'READY_WITH_WARNINGS', warnings: [{ id: 'health-check', category: 'health', severity: 'warning', message: 'x' }] }),
        10,
      ),
    ).toEqual({ heading: '10 checks passed, 1 recommendation', tone: 'attention' });
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
        9,
      ),
    ).toEqual({ heading: 'Fix 2 issues before deploying', tone: 'blocked' });
    expect(preflightPresentation(result({ state: 'UNSUPPORTED', ready: false }), 0)).toMatchObject({ tone: 'blocked' });
  });
});

describe('PreflightSummary', () => {
  it('shows a ready result as one line with the passed checks collapsed', () => {
    const doc = render(result());
    expect(doc.querySelector('[data-testid="preflight-heading"]')?.textContent).toBe('4 checks passed');
    expect(doc.querySelector('[data-testid="preflight-attention"]')).toBeNull();
    expect(doc.querySelector('[data-testid="preflight-passed"]')).toBeNull();
    const toggle = doc.querySelector('button');
    expect(toggle?.textContent).toContain('View details');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(doc.body.textContent).not.toMatch(/Passed/);
    expect(doc.body.textContent).not.toMatch(JARGON);
    expect(doc.body.textContent).not.toMatch(/%/);
  });

  it('shows blocked and recommended checks without a click', () => {
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
    expect(doc.querySelector('[data-testid="preflight-heading"]')?.textContent).toBe('Fix 1 issue before deploying');
    const attention = [...doc.querySelectorAll('[data-testid="preflight-attention"] li')].map((li) => li.getAttribute('data-testid'));
    expect(attention).toEqual(['preflight-check-customer-variables', 'preflight-check-health']);
    expect(doc.querySelector('[data-testid="preflight-check-customer-variables"]')?.textContent).toContain('Missing: STRIPE_SECRET_KEY');
    expect(doc.querySelector('[data-testid="preflight-passed"]')).toBeNull();
  });
});

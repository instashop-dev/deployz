import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DiagnosticCard } from '../src/components/diagnostic-card';
import type { Diagnostic } from '../src/lib/diagnostics';

// AI MVP Phase 6 — the normalised failure context stays inside the card's
// "Technical detail" disclosure; the top level keeps the plain what/why/fix.

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN)\b/i;

const diagnostic: Diagnostic = {
  failureCode: 'DATABASE_CREATE_FAILED',
  recoverability: 'USER_ACTION',
  occurredAt: '2026-09-05T00:00:00.000Z',
  event: { source: 'deployment', action: 'INSTALL' },
  explanation: {
    what: 'The database could not be created.',
    why: 'The account rejected the database this application requires.',
    fix: 'Check the account limits, then run the install link again.',
  },
  context: {
    phase: 'INSTALL',
    attempt: 2,
    failureCode: 'DATABASE_CREATE_FAILED',
    reportedFailureCode: 'STACK_CREATE_FAILED',
    resourceType: 'AWS::RDS::DBInstance',
    message: 'Stack rolled back',
    relevantEvents: [
      { logicalResourceId: 'Database', resourceType: 'AWS::RDS::DBInstance', resourceStatus: 'CREATE_FAILED', reason: 'quota reached' },
    ],
    applicationVersion: 'v1.2.0',
  },
};

function render(input: Diagnostic): Document {
  return new JSDOM(renderToString(<DiagnosticCard diagnostic={input} />)).window.document;
}

describe('DiagnosticCard — technical context', () => {
  it('keeps the context behind the disclosure and the top level jargon-free', () => {
    const doc = render(diagnostic);
    const details = doc.querySelector('details');
    expect(details?.textContent).toContain('INSTALL (attempt 2)');
    expect(details?.textContent).toContain('STACK_CREATE_FAILED');
    expect(details?.textContent).toContain('v1.2.0');
    expect(doc.querySelector('[data-testid="diagnostic-failed-resources"]')?.textContent).toContain(
      'Database · AWS::RDS::DBInstance · CREATE_FAILED — quota reached',
    );
    const topLevel = [...doc.querySelectorAll('dl, h3')].map((el) => el.textContent).join(' ');
    expect(topLevel).not.toMatch(JARGON);
  });

  it('renders without a context (older responses)', () => {
    const doc = render({ ...diagnostic, context: null });
    expect(doc.querySelector('[data-testid="diagnostic-failed-resources"]')).toBeNull();
    expect(doc.querySelector('details')?.textContent).toContain('DATABASE_CREATE_FAILED');
  });
});

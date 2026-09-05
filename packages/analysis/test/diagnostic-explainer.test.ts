/**
 * AI MVP Phase 7 — the diagnostic explainer's structured output: what / why /
 * fix plus the model's own confidence, validated strictly; the deterministic
 * failure code always wins; the prompt asks for honesty about certainty and
 * carries only sanitised structured fields.
 */

import { describe, expect, it } from 'vitest';

import type { AiGateway } from '../src/ai-gateway.js';
import { buildDiagnosticPrompt, diagnosticExplanationSchema, explainDiagnostic } from '../src/diagnostic-explainer.js';

function gatewayReturning(object: unknown): AiGateway {
  return {
    async generate() {
      return { object, usage: { promptTokens: 50, completionTokens: 40 } };
    },
  };
}

const event = {
  source: 'deployment',
  action: 'INSTALL',
  error: { message: 'Stack rolled back: AWS_SECRET_ACCESS_KEY=abcd1234 rejected' },
  context: { deploymentState: 'FAILED', failedResources: ['AWS::RDS::DBInstance CREATE_FAILED: quota'] },
};

describe('diagnosticExplanationSchema', () => {
  it('requires a confidence level and rejects anything outside what/why/fix/confidence', () => {
    expect(diagnosticExplanationSchema.safeParse({ failureCode: 'UNKNOWN', what: 'w', why: 'y', fix: 'f' }).success).toBe(false);
    expect(
      diagnosticExplanationSchema.safeParse({ failureCode: 'UNKNOWN', what: 'w', why: 'y', fix: 'f', confidence: 'certain' }).success,
    ).toBe(false);
    expect(
      diagnosticExplanationSchema.safeParse({ failureCode: 'UNKNOWN', what: 'w', why: 'y', fix: 'f', confidence: 'low', terraform: 'x' })
        .success,
    ).toBe(false);
    expect(diagnosticExplanationSchema.safeParse({ failureCode: 'UNKNOWN', what: 'w', why: 'y', fix: 'f', confidence: 'medium' }).success).toBe(
      true,
    );
  });
});

describe('buildDiagnosticPrompt', () => {
  it('asks for confidence with the honesty rule and redacts the structured fields', () => {
    const prompt = buildDiagnosticPrompt('UNKNOWN', event);
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('Never overstate certainty');
    expect(prompt).toContain('mark confidence "low"');
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).not.toContain('abcd1234');
    expect(prompt).toContain('failedResources');
  });
});

describe('explainDiagnostic', () => {
  it('returns the confidence with the text and overrides the echoed code with the deterministic one', async () => {
    const result = await explainDiagnostic(
      'UNKNOWN',
      event,
      gatewayReturning({ failureCode: 'PORT_MISMATCH', what: 'w', why: 'y', fix: 'f', confidence: 'low' }),
    );
    expect(result).toEqual({ failureCode: 'UNKNOWN', what: 'w', why: 'y', fix: 'f', confidence: 'low' });
  });

  it('rejects output without a confidence so an older-shaped answer never reaches the vendor', async () => {
    await expect(
      explainDiagnostic('UNKNOWN', event, gatewayReturning({ failureCode: 'UNKNOWN', what: 'w', why: 'y', fix: 'f' })),
    ).rejects.toThrow();
  });
});

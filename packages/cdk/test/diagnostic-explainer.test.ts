import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_MAX_TOKENS,
  estimateTokens,
  type AiGateway,
  type AiGatewayResponse,
} from '../src/analysis/ai-explainer.js';
import { classifyFailure, type StructuredEvent } from '../src/analysis/failure-classifier.js';
import { parseDiagnosticEvent } from '../src/analysis/diagnostic-event-schema.js';
import {
  buildDiagnosticPrompt,
  diagnosticExplanationSchema,
  explainDiagnostic,
} from '../src/analysis/diagnostic-explainer.js';

// A realistic raw application log line — the thing §16 must never carry.
const RAW_LOG =
  '[2026-08-21T00:00:00Z] ERROR [app] unhandled exception at server.ts:42 — stack=...';

// A representative structured event (the kind the classifier + explainer see).
const ecsEvent: StructuredEvent = {
  source: 'ecs',
  action: 'deploy',
  error: {
    code: 'InvalidParameterException',
    message: 'task definition invalid',
    statusCode: 400,
  },
  context: { desiredCount: 3, runningCount: 1 },
};

// ==========================================================================
// Recorded gateway fixtures — replays of the real Cloudflare AI Gateway
// ==========================================================================

const recordedValid: AiGatewayResponse = {
  object: {
    failureCode: 'ECS_DEPLOYMENT_FAILED',
    what: 'Your application failed to start in the container.',
    why: 'The ECS task could not be launched.',
    fix: 'Check the task definition and redeploy.',
  },
  usage: { promptTokens: 110, completionTokens: 40 },
};

/** The model tries to flip the deterministic code to a different one. */
const recordedFlip: AiGatewayResponse = {
  object: {
    failureCode: 'PORT_MISMATCH',
    what: 'The app listens on the wrong port.',
    why: 'A port mismatch.',
    fix: 'Change the port.',
  },
  usage: { promptTokens: 110, completionTokens: 30 },
};

const recordedMalformed: AiGatewayResponse = {
  object: '{"failureCode": "ECS_DEPLOYMENT_FAILED", "what": "unterminated',
  usage: { promptTokens: 110, completionTokens: 12 },
};

const recordedMissingFields: AiGatewayResponse = {
  object: { failureCode: 'ECS_DEPLOYMENT_FAILED', what: 'It failed.' },
  usage: { promptTokens: 110, completionTokens: 10 },
};

/** S10 violation — the model hallucinates a `terraform` field (infra content). */
const recordedExtraField: AiGatewayResponse = {
  object: {
    failureCode: 'ECS_DEPLOYMENT_FAILED',
    what: 'It failed.',
    why: 'The task failed.',
    fix: 'Redeploy.',
    terraform: 'resource "aws_ecs_service" "svc" {}',
  },
  usage: { promptTokens: 110, completionTokens: 40 },
};

const recordedOverspend: AiGatewayResponse = {
  object: { failureCode: 'ECS_DEPLOYMENT_FAILED', what: 'w', why: 'y', fix: 'f' },
  usage: { promptTokens: 700, completionTokens: 500 },
};

/** Build a recorded-fixture gateway that replays one response (optionally capturing the prompt). */
function recordedGateway(
  response: AiGatewayResponse,
  onGenerate?: (prompt: string) => void,
): AiGateway {
  return {
    async generate(prompt) {
      onGenerate?.(prompt);
      return response;
    },
  };
}

// ==========================================================================
// Zod-validated what/why/fix output
// ==========================================================================

describe('explainDiagnostic — Zod-validated what/why/fix output', () => {
  it('parses a valid recorded response and returns the explanation', async () => {
    const explanation = await explainDiagnostic(
      'ECS_DEPLOYMENT_FAILED',
      ecsEvent,
      recordedGateway(recordedValid),
    );
    expect(explanation).toEqual({
      failureCode: 'ECS_DEPLOYMENT_FAILED',
      what: 'Your application failed to start in the container.',
      why: 'The ECS task could not be launched.',
      fix: 'Check the task definition and redeploy.',
    });
  });

  it('rejects malformed output (unterminated JSON string)', async () => {
    await expect(
      explainDiagnostic('ECS_DEPLOYMENT_FAILED', ecsEvent, recordedGateway(recordedMalformed)),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('rejects output with missing fields', async () => {
    await expect(
      explainDiagnostic(
        'ECS_DEPLOYMENT_FAILED',
        ecsEvent,
        recordedGateway(recordedMissingFields),
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('rejects a non-failure-code value (invalid enum member)', async () => {
    const bad: AiGatewayResponse = {
      object: { failureCode: 'NOT_A_REAL_CODE', what: 'w', why: 'y', fix: 'f' },
      usage: { promptTokens: 10, completionTokens: 10 },
    };
    await expect(
      explainDiagnostic('ECS_DEPLOYMENT_FAILED', ecsEvent, recordedGateway(bad)),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});

// ==========================================================================
// §20 guard — the AI can NEVER flip the deterministic failure code
// ==========================================================================

describe('explainDiagnostic — §20 guard (AI cannot flip the failure code)', () => {
  it('keeps the deterministic code when the model tries to flip it', async () => {
    const explanation = await explainDiagnostic(
      'AWS_SCP_BLOCKED',
      ecsEvent,
      recordedGateway(recordedFlip),
    );
    // The deterministic code is the source of truth — the AI's echo is overridden.
    expect(explanation.failureCode).toBe('AWS_SCP_BLOCKED');
    // The AI text still comes through; only the code is authoritative.
    expect(explanation.what).toBe('The app listens on the wrong port.');
  });

  it('keeps the deterministic code under a flip attempt for every code', async () => {
    const codes = ['PORT_MISMATCH', 'QUOTA_EXCEEDED', 'UNKNOWN'] as const;
    for (const code of codes) {
      const flip: AiGatewayResponse = {
        object: { failureCode: 'AWS_SCP_BLOCKED', what: 'w', why: 'y', fix: 'f' },
        usage: { promptTokens: 10, completionTokens: 10 },
      };
      const explanation = await explainDiagnostic(code, ecsEvent, recordedGateway(flip));
      expect(explanation.failureCode).toBe(code);
    }
  });
});

// ==========================================================================
// S10 — explanations only (schema shape)
// ==========================================================================

describe('diagnosticExplanationSchema — S10 explanations-only (no code/config/infra fields)', () => {
  it('has exactly the four fields: failureCode, what, why, fix', () => {
    expect(Object.keys(diagnosticExplanationSchema.shape).sort()).toEqual([
      'failureCode',
      'fix',
      'what',
      'why',
    ]);
  });

  it('is strict — an extra `terraform` field is rejected (no infra content)', () => {
    expect(() => diagnosticExplanationSchema.parse(recordedExtraField.object)).toThrow(
      z.ZodError,
    );
  });

  it('rejects any code/config/iam/terraform field at the engine boundary', async () => {
    await expect(
      explainDiagnostic('ECS_DEPLOYMENT_FAILED', ecsEvent, recordedGateway(recordedExtraField)),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});

// ==========================================================================
// Spend-limit enforcement
// ==========================================================================

describe('explainDiagnostic — spend-limit enforcement', () => {
  it('refuses when the gateway reports usage above the budget', async () => {
    // 700 + 500 = 1200 > DEFAULT_MAX_TOKENS (1000).
    await expect(
      explainDiagnostic('ECS_DEPLOYMENT_FAILED', ecsEvent, recordedGateway(recordedOverspend)),
    ).rejects.toThrow(/spend limit exceeded/i);
  });

  it('truncates an oversized prompt to the token budget', async () => {
    let seenPrompt = '';
    const hugeEvent: StructuredEvent = {
      source: 'ecs',
      context: { blob: 'x'.repeat(10_000) },
    };
    await explainDiagnostic(
      'ECS_DEPLOYMENT_FAILED',
      hugeEvent,
      recordedGateway(recordedValid, (p) => (seenPrompt = p)),
    );
    expect(estimateTokens(seenPrompt)).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS);
  });
});

// ==========================================================================
// §16 guard — no raw logs in AI payloads
// ==========================================================================

describe('explainDiagnostic — §16 guard (no raw logs in AI payloads)', () => {
  it('a raw-log-bearing event is rejected at the input edge and never reaches the explainer', () => {
    // The schema rejects the raw-log fields BEFORE the explainer is ever called.
    expect(() => parseDiagnosticEvent({ source: 'ecs', log: RAW_LOG })).toThrow(z.ZodError);
    expect(() => parseDiagnosticEvent({ source: 'ecs', stdout: RAW_LOG })).toThrow(z.ZodError);
  });

  it('the validated event contains no free-form log field', () => {
    const event = parseDiagnosticEvent({
      source: 'ecs',
      error: { code: 'InvalidParameterException' },
      context: { desiredCount: 3 },
    });
    expect(event).not.toHaveProperty('log');
    expect(event).not.toHaveProperty('stdout');
    expect(event).not.toHaveProperty('rawLog');
    expect(event).not.toHaveProperty('stderr');
  });

  it('the prompt built from a validated event carries no raw-log marker', () => {
    const event = parseDiagnosticEvent({
      source: 'ecs',
      action: 'deploy',
      error: { code: 'InvalidParameterException', message: 'task definition invalid' },
      context: { desiredCount: 3, runningCount: 1 },
    });
    const prompt = buildDiagnosticPrompt('ECS_DEPLOYMENT_FAILED', event);
    // No raw-log field name or raw-log text appears in the prompt.
    for (const marker of ['stdout', 'stderr', 'rawLog', 'stack trace']) {
      expect(prompt.toLowerCase()).not.toContain(marker);
    }
    expect(prompt).not.toContain(RAW_LOG);
    // But the structured fields ARE present (the prompt is meaningful).
    expect(prompt).toContain('ECS_DEPLOYMENT_FAILED');
    expect(prompt).toContain('ecs');
    expect(prompt).toContain('InvalidParameterException');
  });
});

// ==========================================================================
// Pipeline — classify then explain (the full §16 → §20 flow)
// ==========================================================================

describe('explainDiagnostic — pipeline (classify a validated event, then explain)', () => {
  it('classifies a validated event then explains the deterministic code', async () => {
    const event = parseDiagnosticEvent({
      source: 'health-check',
      signal: 'port',
      context: { expectedPort: 3000, actualPort: 8080 },
    });
    const code = classifyFailure(event); // §29 example → PORT_MISMATCH
    expect(code).toBe('PORT_MISMATCH');

    const response: AiGatewayResponse = {
      object: { failureCode: 'PORT_MISMATCH', what: 'w', why: 'y', fix: 'f' },
      usage: { promptTokens: 10, completionTokens: 10 },
    };
    const explanation = await explainDiagnostic(code, event, recordedGateway(response));
    expect(explanation.failureCode).toBe('PORT_MISMATCH');
    expect(explanation.what).toBe('w');
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_MAX_TOKENS,
  explanationSchema,
  explainCompatibility,
  buildPrompt,
  estimateTokens,
  truncateToTokens,
  type AiGateway,
  type AiGatewayResponse,
} from './ai-explainer.js';
import type { CompatibilityResult } from './rules.js';

// ==========================================================================
// Deterministic verdicts (inputs to the explainer)
// ==========================================================================

const readyVerdict: CompatibilityResult = {
  verdict: 'READY',
  reason: 'Compatible with Deployz',
  issues: [],
};

const needsAttentionVerdict: CompatibilityResult = {
  verdict: 'NEEDS_ATTENTION',
  reason: 'Missing Dockerfile',
  issues: [
    { severity: 'attention', code: 'MISSING_DOCKERFILE', message: 'Missing Dockerfile' },
  ],
};

const notCompatibleVerdict: CompatibilityResult = {
  verdict: 'NOT_COMPATIBLE',
  reason: 'Requires Redis Stack modules (RedisJSON/RediSearch), which Deployz does not support.',
  issues: [
    {
      severity: 'reject',
      code: 'REDIS_UNSUPPORTED',
      message: 'Requires Redis Stack modules (RedisJSON/RediSearch), which Deployz does not support.',
    },
  ],
};

const context = { applicationName: 'acme-api' };

// ==========================================================================
// Recorded gateway fixtures — replays of the real Cloudflare AI Gateway
// (Vercel AI SDK `generateObject` output). No live gateway in this env.
// ==========================================================================

/** A valid READY explanation, as recorded from the gateway. */
const recordedReady: AiGatewayResponse = {
  object: {
    verdict: 'READY',
    summary: 'Your app is ready to deploy.',
    why: 'It uses a supported database and includes everything needed to run.',
    fix: 'Nothing to do.',
  },
  usage: { promptTokens: 96, completionTokens: 34 },
};

/** A valid NEEDS_ATTENTION explanation, as recorded from the gateway. */
const recordedNeedsAttention: AiGatewayResponse = {
  object: {
    verdict: 'NEEDS_ATTENTION',
    summary: 'Your app is close, but needs a container definition.',
    why: 'A container definition (Dockerfile) is missing.',
    fix: 'Add a Dockerfile describing how to build and run the app.',
  },
  usage: { promptTokens: 104, completionTokens: 38 },
};

/** A valid NOT_COMPATIBLE explanation, as recorded from the gateway. */
const recordedNotCompatible: AiGatewayResponse = {
  object: {
    verdict: 'NOT_COMPATIBLE',
    summary: 'Your app uses a database we do not support yet.',
    why: 'It depends on Redis, which is not currently supported.',
    fix: 'Replace Redis with the PostgreSQL database we provide.',
  },
  usage: { promptTokens: 110, completionTokens: 41 },
};

/** The model tries to flip a READY verdict to NOT_COMPATIBLE. */
const recordedFlipAttempt: AiGatewayResponse = {
  object: {
    verdict: 'NOT_COMPATIBLE',
    summary: 'This app cannot be deployed.',
    why: 'It uses an unsupported database.',
    fix: 'Rewrite the database layer.',
  },
  usage: { promptTokens: 96, completionTokens: 30 },
};

/** Malformed output — the model returned an unterminated JSON string. */
const recordedMalformed: AiGatewayResponse = {
  object: '{"verdict": "READY", "summary": "unterminated',
  usage: { promptTokens: 96, completionTokens: 12 },
};

/** Missing fields — no `fix` (and no `why`). */
const recordedMissingFields: AiGatewayResponse = {
  object: { verdict: 'READY', summary: 'It is ready.' },
  usage: { promptTokens: 96, completionTokens: 10 },
};

/** S10 violation — the model hallucinates a `terraform` field (infra content). */
const recordedCodeContent: AiGatewayResponse = {
  object: {
    verdict: 'READY',
    summary: 'It is ready.',
    why: 'All checks passed.',
    fix: 'Nothing to do.',
    terraform: 'resource "aws_db_instance" "db" { engine = "postgres" }',
  },
  usage: { promptTokens: 96, completionTokens: 40 },
};

/**
 * A response whose reported usage exceeds the default budget.
 *
 * Derived from the budget rather than hardcoded, so raising the budget cannot
 * silently turn this into a test that no longer exercises the guard.
 */
const recordedOverspend: AiGatewayResponse = {
  object: {
    verdict: 'READY',
    summary: 'Ready.',
    why: 'Why.',
    fix: 'Nothing.',
  },
  usage: { promptTokens: DEFAULT_MAX_TOKENS, completionTokens: 1 },
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
// Structured-output validation (Zod)
// ==========================================================================

describe('explainCompatibility — structured-output validation (Zod)', () => {
  it('parses a valid recorded response and returns the explanation', async () => {
    const explanation = await explainCompatibility(
      readyVerdict,
      context,
      recordedGateway(recordedReady),
    );

    expect(explanation).toEqual({
      verdict: 'READY',
      summary: 'Your app is ready to deploy.',
      why: 'It uses a supported database and includes everything needed to run.',
      fix: 'Nothing to do.',
    });
  });

  it('parses valid recorded responses for all three verdict classes', async () => {
    const cases: Array<{
      deterministic: CompatibilityResult;
      recorded: AiGatewayResponse;
      expectedVerdict: string;
    }> = [
      { deterministic: readyVerdict, recorded: recordedReady, expectedVerdict: 'READY' },
      {
        deterministic: needsAttentionVerdict,
        recorded: recordedNeedsAttention,
        expectedVerdict: 'NEEDS_ATTENTION',
      },
      {
        deterministic: notCompatibleVerdict,
        recorded: recordedNotCompatible,
        expectedVerdict: 'NOT_COMPATIBLE',
      },
    ];

    for (const { deterministic, recorded, expectedVerdict } of cases) {
      const explanation = await explainCompatibility(
        deterministic,
        context,
        recordedGateway(recorded),
      );
      expect(explanation.verdict).toBe(expectedVerdict);
    }
  });

  it('rejects malformed output (unterminated JSON string)', async () => {
    await expect(
      explainCompatibility(readyVerdict, context, recordedGateway(recordedMalformed)),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('rejects output with missing fields', async () => {
    await expect(
      explainCompatibility(
        readyVerdict,
        context,
        recordedGateway(recordedMissingFields),
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('rejects a non-verdict verdict value (invalid enum member)', async () => {
    const badVerdict: AiGatewayResponse = {
      object: { verdict: 'UNKNOWN', summary: 's', why: 'w', fix: 'f' },
      usage: { promptTokens: 10, completionTokens: 10 },
    };
    await expect(
      explainCompatibility(readyVerdict, context, recordedGateway(badVerdict)),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});

// ==========================================================================
// §20 guard — the AI can NEVER flip the deterministic verdict
// ==========================================================================

describe('explainCompatibility — §20 guard (AI cannot flip the verdict)', () => {
  it('keeps READY when the model tries to flip to NOT_COMPATIBLE', async () => {
    const explanation = await explainCompatibility(
      readyVerdict,
      context,
      recordedGateway(recordedFlipAttempt),
    );

    // The deterministic verdict is the source of truth — the AI's echo is overridden.
    expect(explanation.verdict).toBe('READY');
    // The AI text still comes through; only the verdict is authoritative.
    expect(explanation.summary).toBe('This app cannot be deployed.');
  });

  it('keeps the deterministic verdict for every verdict class under a flip attempt', async () => {
    const cases: Array<{ deterministic: CompatibilityResult; flipTo: string }> = [
      { deterministic: readyVerdict, flipTo: 'NOT_COMPATIBLE' },
      { deterministic: needsAttentionVerdict, flipTo: 'READY' },
      { deterministic: notCompatibleVerdict, flipTo: 'READY' },
    ];

    for (const { deterministic, flipTo } of cases) {
      const flipResponse: AiGatewayResponse = {
        object: { verdict: flipTo, summary: 's', why: 'w', fix: 'f' },
        usage: { promptTokens: 10, completionTokens: 10 },
      };
      const explanation = await explainCompatibility(
        deterministic,
        context,
        recordedGateway(flipResponse),
      );
      expect(explanation.verdict).toBe(deterministic.verdict);
    }
  });
});

// ==========================================================================
// S10 — explanations only (schema shape)
// ==========================================================================

describe('explanationSchema — S10 explanations-only (no code/config/infra fields)', () => {
  it('has exactly the four fields: verdict, summary, why, fix', () => {
    expect(Object.keys(explanationSchema.shape).sort()).toEqual([
      'fix',
      'summary',
      'verdict',
      'why',
    ]);
  });

  it('is strict — an extra `terraform` field is rejected (no infra content)', () => {
    expect(() => explanationSchema.parse(recordedCodeContent.object)).toThrow(
      z.ZodError,
    );
  });

  it('rejects any code/config/iam/terraform field at the engine boundary', async () => {
    await expect(
      explainCompatibility(readyVerdict, context, recordedGateway(recordedCodeContent)),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});

// ==========================================================================
// Spend-limit enforcement
// ==========================================================================

describe('explainCompatibility — spend-limit enforcement', () => {
  it('refuses when the gateway reports usage above the budget', async () => {
    await expect(
      explainCompatibility(readyVerdict, context, recordedGateway(recordedOverspend)),
    ).rejects.toThrow(/spend limit exceeded/i);
  });

  it('refuses when a custom budget is exceeded', async () => {
    const smallResponse: AiGatewayResponse = {
      object: { verdict: 'READY', summary: 's', why: 'w', fix: 'f' },
      usage: { promptTokens: 50, completionTokens: 50 },
    };
    await expect(
      explainCompatibility(readyVerdict, context, recordedGateway(smallResponse), {
        maxTokens: 80,
      }),
    ).rejects.toThrow(/spend limit exceeded/i);
  });

  it('truncates an oversized prompt to the token budget', async () => {
    let seenPrompt = '';
    const hugeContext = {
      applicationName: 'acme-api',
      metadata: { blob: 'x'.repeat(10_000) },
    };

    await explainCompatibility(readyVerdict, hugeContext, recordedGateway(recordedReady, (p) => (seenPrompt = p)));

    // The prompt handed to the gateway must fit within the budget.
    expect(estimateTokens(seenPrompt)).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS);
  });
});

// ==========================================================================
// Token-volume measurement (U5) — from recorded fixtures
// ==========================================================================

describe('explainCompatibility — U5 token-volume measurement', () => {
  it('measures prompt + completion tokens from a recorded fixture', async () => {
    let seenPrompt = '';
    const onGenerate = (prompt: string) => (seenPrompt = prompt);

    await explainCompatibility(readyVerdict, context, recordedGateway(recordedReady, onGenerate));

    const measuredPromptTokens = estimateTokens(seenPrompt);
    const measuredCompletionTokens = recordedReady.usage.completionTokens;
    const total = measuredPromptTokens + measuredCompletionTokens;

    // The measured request fits the default budget.
    expect(total).toBeLessThanOrEqual(DEFAULT_MAX_TOKENS);
    // Sanity: the recorded completion tokens are small.
    expect(recordedReady.usage.completionTokens).toBeGreaterThan(0);
  });

  it('truncateToTokens never exceeds the budget and buildPrompt is finite', () => {
    const longText = 'a'.repeat(5000);
    expect(estimateTokens(truncateToTokens(longText, 100))).toBeLessThanOrEqual(100);
    const prompt = buildPrompt(notCompatibleVerdict, context);
    expect(estimateTokens(prompt)).toBeGreaterThan(0);
  });
});

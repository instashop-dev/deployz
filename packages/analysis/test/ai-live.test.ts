/**
 * §43 live gateway integration test — env-gated proof that this package's AI
 * layers (`analyseRepositoryWithAi`, `explainDiagnostic`) work against the
 * REAL Cloudflare AI Gateway, not just the recorded-fixture `AiGateway` used
 * everywhere else in this package's test suite.
 *
 * Gated exactly like `packages/cdk/test/golden-path-live-aws.test.ts`: CI
 * never sets `DEPLOYZ_LIVE_AI`, so `pnpm vitest run` skips this suite by
 * default (no network access, no spend). A developer opts in locally with
 * `DEPLOYZ_LIVE_AI=1` plus real gateway credentials.
 *
 * Because a live model's prose is not deterministic, assertions here are
 * limited to STRUCTURE and GATES the strict Zod schemas already enforce
 * (e.g. `postgres.required` is a boolean, `warnings` is an array) — never
 * exact wording. See ai-gateway.ts's `MAX_OUTPUT_TOKENS` doc comment: even
 * response completeness is probabilistic against a reasoning model, so a
 * flaky failure here should be re-run before it is treated as a regression.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { createAiGateway, type AiGateway, type AiGatewayConfig } from '../src/ai-gateway.js';
import { analyseRepositoryWithAi, type RepositoryAiInput } from '../src/repository-ai.js';
import { explainDiagnostic } from '../src/diagnostic-explainer.js';
import type { StructuredEvent } from '../src/failure-codes.js';

/**
 * Reads the gateway config from `process.env`. Called only from inside a
 * `beforeAll`/`it` body (never at describe-collection time), so a
 * non-live run — where `describe.skip` still evaluates the suite's factory
 * function to collect its tests, but never runs hooks or test bodies — can
 * never throw on missing credentials. A live run with anything missing fails
 * fast with the names of everything absent, rather than surfacing as a
 * confusing 401 or network error deeper in the gateway.
 */
function readLiveGatewayConfig(): AiGatewayConfig {
  const baseUrl = process.env.AI_GATEWAY_BASE_URL;
  const model = process.env.AI_MODEL;
  const providerApiKey = process.env.AI_PROVIDER_API_KEY;
  const gatewayToken = process.env.AI_GATEWAY_TOKEN;

  if (!baseUrl || !model || !providerApiKey) {
    throw new Error(
      'DEPLOYZ_LIVE_AI=1 requires AI_GATEWAY_BASE_URL, AI_MODEL, and AI_PROVIDER_API_KEY to be set ' +
        '(see .env.example) — a real Cloudflare AI Gateway base URL, model, and upstream provider ' +
        'key. AI_GATEWAY_TOKEN is optional (only needed for a gateway with authentication switched on).',
    );
  }

  return { baseUrl, model, providerApiKey, gatewayToken };
}

const live = process.env.DEPLOYZ_LIVE_AI === '1' ? describe : describe.skip;

live(
  '§43 live Cloudflare AI Gateway integration',
  { timeout: 60_000 },
  () => {
    let gateway: AiGateway;

    beforeAll(() => {
      gateway = createAiGateway(readLiveGatewayConfig());
    });

    it(
      'analyseRepositoryWithAi returns a schema-valid result for a monorepo-shaped input',
      async () => {
        const input: RepositoryAiInput = {
          detected: {
            packageManager: 'pnpm',
            framework: null,
            buildCommand: null,
            startCommand: null,
            port: null,
            dockerfilePath: null,
            postgresRequired: false,
            redisRequired: false,
            migrationCommandDetected: false,
          },
          files: [
            {
              path: 'package.json',
              content: JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }, null, 2),
            },
            {
              path: 'apps/api/package.json',
              content: JSON.stringify(
                { name: 'api', scripts: { start: 'node dist/index.js', build: 'tsc' } },
                null,
                2,
              ),
            },
          ],
          unresolved: ['monorepo-target', 'start-command-unknown'],
        };

        // repositoryAiSchema.parse() inside analyseRepositoryWithAi already
        // throws on a malformed response, so a resolved promise already
        // proves schema validity — the assertions below double as an
        // explicit record of the gates that matter to callers.
        const result = await analyseRepositoryWithAi(input, gateway);

        expect(typeof result.workingDirectory).toBe('string');
        expect(result.buildCommand === null || typeof result.buildCommand === 'string').toBe(true);
        expect(result.startCommand === null || typeof result.startCommand === 'string').toBe(true);
        expect(result.port === null || typeof result.port === 'number').toBe(true);
        expect(typeof result.postgres.required).toBe('boolean');
        expect(Array.isArray(result.postgres.evidence)).toBe(true);
        expect(typeof result.redis.required).toBe('boolean');
        expect(Array.isArray(result.redis.evidence)).toBe(true);
        expect(result.migrationCommand === null || typeof result.migrationCommand === 'string').toBe(true);
        expect(Array.isArray(result.warnings)).toBe(true);
      },
      30_000,
    );

    it('explainDiagnostic returns a schema-valid what/why/fix for UNKNOWN', async () => {
      const event: StructuredEvent = {
        source: 'relay',
        action: 'deploy',
        error: { message: 'the deployment failed with no recognizable pattern in the observed signals' },
      };

      // §20 guard: the deterministic failure code always wins, so
      // failureCode is asserted exactly; what/why/fix are model prose and
      // are only checked for shape (non-empty strings).
      const result = await explainDiagnostic('UNKNOWN', event, gateway);

      expect(result.failureCode).toBe('UNKNOWN');
      expect(typeof result.what).toBe('string');
      expect(result.what.length).toBeGreaterThan(0);
      expect(typeof result.why).toBe('string');
      expect(result.why.length).toBeGreaterThan(0);
      expect(typeof result.fix).toBe('string');
      expect(result.fix.length).toBeGreaterThan(0);
    });
  },
);

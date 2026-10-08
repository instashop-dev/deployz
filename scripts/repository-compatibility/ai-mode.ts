/**
 * AI mode of the audit harnesses.
 *
 *   off   the gateway is unconfigured (`createAiGateway(undefined)`): the
 *         §15 fallback degrades deterministically and no AI request is made.
 *         This is the default and a diagnostic mode, not production-equivalent.
 *   live  the gateway is built the way `apps/api/src/env.ts` builds it
 *         (`describeAiGatewayConfig` over the environment, then
 *         `createAiGateway`). `runApplicationAnalysis` keeps applying the
 *         production `REPO_AI_TIMEOUT_MS`; the harness adds no timeout.
 *
 * Every result records the mode, the model, the request count and the
 * outcome. Error text is sanitized: no key, token or URL reaches a file.
 */
import { createAiGateway, type AiGateway } from '@deployz/analysis';
import { describeAiGatewayConfig } from '@deployz/api/ai-config';

export type AiMode = 'off' | 'live';

export type AiOutcome =
  | 'completed'
  | 'timeout'
  | 'auth-error'
  | 'routing-error'
  | 'parse-error'
  | 'fallback'
  | 'not-requested';

export interface AiRecord {
  mode: AiMode;
  /** The configured model in `live`; null in `off`. */
  model: string | null;
  requests: number;
  outcome: AiOutcome;
  error: string | null;
}

export const AI_OFF_RECORD: AiRecord = { mode: 'off', model: null, requests: 0, outcome: 'not-requested', error: null };

const MAX_ERROR_LENGTH = 300;

export function parseAiMode(value: string | undefined): AiMode {
  if (value === undefined || value === 'off') return 'off';
  if (value === 'live') return 'live';
  throw new Error(`--ai must be "off" or "live", got "${value}"`);
}

/** Message for a live run whose environment does not configure the gateway. Names variables, never values. */
export function liveConfigProblem(env: Record<string, string | undefined>, problem: 'missing' | 'reused-secret' | undefined): string {
  if (problem === 'reused-secret') {
    return '--ai live: AI_PROVIDER_API_KEY and AI_GATEWAY_TOKEN must differ (the same value is set for both)';
  }
  const missing = ['AI_GATEWAY_BASE_URL', 'AI_PROVIDER_API_KEY'].filter((name) => !env[name]);
  return `--ai live: missing environment variable(s): ${missing.join(', ')}`;
}

export interface SessionGateway {
  gateway: AiGateway;
  mode: AiMode;
  model: string | null;
  /** Credential values to strip from recorded errors. */
  secrets: string[];
}

/** The gateway for a mode. `live` fails fast, before any entry is analysed, when the configuration is incomplete. */
export function buildSessionGateway(mode: AiMode, env: Record<string, string | undefined> = process.env): SessionGateway {
  if (mode === 'off') return { gateway: createAiGateway(undefined), mode, model: null, secrets: [] };
  const { config, problem } = describeAiGatewayConfig(env);
  if (!config) throw new Error(liveConfigProblem(env, problem));
  const secrets = [config.providerApiKey, config.gatewayToken].filter((value): value is string => Boolean(value));
  return { gateway: createAiGateway(config), mode, model: config.model, secrets };
}

/** Removes anything credential-shaped from an error message and bounds its length. */
export function sanitizeAiError(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  text = text
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\b(authorization|cf-aig-authorization|x-api-key|api[-_]?key|token)(["']?\s*[:=]\s*)[^\s"',;]+/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Classifies one gateway failure. A failure that is none of the named classes is a `fallback`. */
export function classifyAiError(error: unknown): Exclude<AiOutcome, 'completed' | 'not-requested'> {
  const chain: unknown[] = [error];
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown; lastError?: unknown }).cause ?? (error as { lastError?: unknown }).lastError : undefined;
  if (cause) chain.push(cause);
  for (const item of chain) {
    const name = item && typeof item === 'object' && 'name' in item ? String((item as { name: unknown }).name) : '';
    const message = item instanceof Error ? item.message : String(item);
    const status = statusOf(item);
    if (name === 'AbortError' || name === 'TimeoutError' || /\b(aborted|timed? ?out)\b/i.test(message)) return 'timeout';
    if (status === 401 || status === 403) return 'auth-error';
    if (status === 404 || /model.*(not found|unknown|does not exist)|unknown model/i.test(message)) return 'routing-error';
    if (name === 'AI_NoObjectGeneratedError' || name === 'ZodError' || name === 'AI_TypeValidationError') return 'parse-error';
  }
  return 'fallback';
}

export interface InstrumentedGateway {
  gateway: AiGateway;
  /** Starts counting for the next entry. */
  begin(): void;
  /**
   * The record for the entry since `begin()`. `rejectedAnswer` is true when
   * the gateway answered but the analysis still degraded (the answer failed
   * schema validation or the spend limit, which happen after `generate`).
   */
  finish(options: { rejectedAnswer: boolean }): AiRecord;
}

/** Wraps a gateway so each entry's requests, last error and outcome are recorded. */
export function instrumentGateway(session: SessionGateway): InstrumentedGateway {
  let requests = 0;
  let lastError: unknown;
  let failed = false;
  const gateway: AiGateway = {
    async generate(prompt, schema, options) {
      requests += 1;
      try {
        const response = await session.gateway.generate(prompt, schema, options);
        failed = false;
        lastError = undefined;
        return response;
      } catch (error) {
        failed = true;
        lastError = error;
        throw error;
      }
    },
  };
  return {
    gateway,
    begin() {
      requests = 0;
      lastError = undefined;
      failed = false;
    },
    finish({ rejectedAnswer }) {
      const base = { mode: session.mode, model: session.model, requests };
      if (requests === 0) return { ...base, outcome: 'not-requested', error: null };
      if (failed) return { ...base, outcome: classifyAiError(lastError), error: sanitizeAiError(lastError, session.secrets) };
      if (rejectedAnswer) return { ...base, outcome: 'parse-error', error: 'the AI answer was rejected after the gateway returned it' };
      return { ...base, outcome: 'completed', error: null };
    },
  };
}

/** Summary counts of a result list by mode and outcome. */
export function countAi(records: readonly AiRecord[]): { byMode: Record<string, number>; byOutcome: Record<string, number> } {
  const byMode: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  for (const record of records) {
    byMode[record.mode] = (byMode[record.mode] ?? 0) + 1;
    byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
  }
  const sorted = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  return { byMode: sorted(byMode), byOutcome: sorted(byOutcome) };
}

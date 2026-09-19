/**
 * Jev error taxonomy — one class, many kinds, fixed messages.
 *
 * Every message names what failed and how many attempts were made, and never
 * includes the state, the questions, the answers, the URL, or any credential:
 * the message is safe to log wherever the structured line is not. Callers
 * branch on `kind`; `status` carries the gateway's HTTP status when there was
 * one.
 */

export type JevErrorKind =
  | 'timeout'
  | 'unauthorized'
  | 'validation'
  | 'rate-limited'
  | 'overloaded'
  | 'gateway-error'
  | 'malformed'
  | 'network'
  | 'breaker-open'
  | 'unconfigured';

const KIND_MESSAGES: Record<JevErrorKind, string> = {
  timeout: 'Jev request timed out',
  unauthorized: 'Jev request was rejected as unauthorized',
  validation: 'Jev request failed validation',
  'rate-limited': 'Jev request was rate limited',
  overloaded: 'Jev provider was overloaded',
  'gateway-error': 'Jev gateway returned an error',
  malformed: 'Jev response did not match the expected schema',
  network: 'Jev request failed on the network',
  'breaker-open': 'Jev circuit breaker is open',
  unconfigured: 'Jev client is not configured',
};

export interface JevErrorOptions {
  /** HTTP status when the gateway answered with one. */
  readonly status?: number | undefined;
  /** Attempts actually made — 0 for breaker-open and unconfigured. */
  readonly attempts?: number;
}

export class JevError extends Error {
  /** Which failure mode — the thing callers branch on. */
  readonly kind: JevErrorKind;
  /** HTTP status when the gateway answered with one. */
  readonly status?: number | undefined;
  readonly attempts: number;

  constructor(kind: JevErrorKind, options: JevErrorOptions = {}) {
    const detail = options.status === undefined ? '' : ` (HTTP ${options.status})`;
    super(`${KIND_MESSAGES[kind]}${detail} after ${options.attempts ?? 0} attempt(s).`);
    this.name = 'JevError';
    this.kind = kind;
    this.status = options.status;
    this.attempts = options.attempts ?? 0;
  }
}

/**
 * Shared secret redaction + error-text normalization.
 *
 * Later tasks (5, 7, 8) run `normalizeErrorText` (which itself calls
 * `redactSecrets`) over error text before it reaches AI prompts, so secrets
 * embedded in raw error messages (connection strings, tokens, keys) never
 * leave the deterministic layer.
 */

/** Redaction rules, applied in order. Each is a global regex replace. */
const RULES: Array<[RegExp, string]> = [
  // URL credentials: postgresql://user:pass@host → postgresql://[REDACTED]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // AWS access key ids and session-ish tokens
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  // GitHub tokens (classic + fine-grained + app)
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // Authorization headers
  [/\b(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, '$1[REDACTED]'],
  // KEY=value pairs whose key looks secret (covers .env-style lines and log echoes)
  [
    /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)\S+/g,
    '$1[REDACTED]',
  ],
  // PEM blocks
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  ],
];

/**
 * Redact known secret shapes (URL credentials, cloud/VCS tokens, JWTs,
 * Authorization headers, secret-looking KEY=value pairs, PEM private keys)
 * from arbitrary text. Idempotent — redacting already-redacted text is a
 * no-op.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// The ANSI escape character, built from a char code rather than embedded as
// a literal control character in a regex, so the source has no raw control
// byte and ESLint's `no-control-regex` stays clean.
const ANSI_ESC = String.fromCharCode(27);
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${ANSI_ESC}\\[[0-9;]*[A-Za-z]`, 'g');
const BARE_ANSI_ESCAPE = new RegExp(ANSI_ESC, 'g');

const TRUNCATED_SUFFIX = '…[truncated]';

/** Options for `normalizeErrorText`. */
export interface NormalizeErrorTextOptions {
  /** Maximum length of the returned text (before the truncation suffix). Defaults to 2000. */
  readonly maxLength?: number;
}

/**
 * Normalize raw error text before it reaches an AI prompt: strip ANSI escape
 * codes, collapse runs of identical lines to one, trim, truncate to
 * `maxLength` (default 2000) with a `…[truncated]` suffix, then redact
 * secrets. Idempotent.
 */
export function normalizeErrorText(
  text: string,
  options: NormalizeErrorTextOptions = {},
): string {
  const maxLength = options.maxLength ?? 2000;

  const withoutAnsi = text.replace(ANSI_ESCAPE_SEQUENCE, '').replace(BARE_ANSI_ESCAPE, '');

  const collapsed = withoutAnsi
    .split('\n')
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
    .join('\n');

  const trimmed = collapsed.trim();

  const truncated =
    trimmed.length > maxLength ? trimmed.slice(0, maxLength) + TRUNCATED_SUFFIX : trimmed;

  return redactSecrets(truncated);
}

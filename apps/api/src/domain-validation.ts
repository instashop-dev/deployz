// Custom-domain hostname validation. Pure functions — the API route and the
// UI both rely on the SAME server-side rules; client-side checks are only a
// convenience. Messages are product copy (spec-fixed), not AWS jargon.

export type DomainValidationCode =
  | 'URL_ENTERED'
  | 'INVALID_DOMAIN'
  | 'ROOT_DOMAIN'
  | 'WILDCARD_NOT_SUPPORTED';

export const DOMAIN_VALIDATION_MESSAGES: Record<DomainValidationCode, string> = {
  URL_ENTERED: 'Enter only the domain, for example app.example.com.',
  INVALID_DOMAIN: 'Enter a valid domain such as app.example.com.',
  ROOT_DOMAIN: "Root domains aren't supported yet. Use a subdomain such as app.example.com.",
  WILDCARD_NOT_SUPPORTED: "Wildcard domains aren't supported yet.",
};

// RFC-1123 label: alphanumeric, hyphens inside, 1–63 chars.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Best-effort two-part public suffixes so `example.co.uk` counts as an apex.
// Not a full PSL — a deliberate MVP trade-off.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'ne.jp', 'or.jp',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.in', 'co.za', 'co.kr',
  'com.br', 'com.mx', 'com.ar', 'com.sg', 'com.hk', 'com.tw', 'com.cn',
]);

// Deployz-owned and AWS-internal namespaces must never become customer
// domains (spec security requirement).
const RESERVED_SUFFIXES = [
  'deployz.dev',
  'deployz.app',
  'amazonaws.com',
  'acm-validations.aws',
  'on.aws',
];

export function normalizeHostname(input: string): string {
  return input.trim().toLowerCase().replace(/\.+$/, '');
}

export function validateHostname(
  hostname: string,
): { ok: true } | { ok: false; code: DomainValidationCode; message: string } {
  const fail = (code: DomainValidationCode) =>
    ({ ok: false, code, message: DOMAIN_VALIDATION_MESSAGES[code] }) as const;

  if (hostname.includes('*')) return fail('WILDCARD_NOT_SUPPORTED');
  if (/[/:?#@\s]/.test(hostname)) return fail('URL_ENTERED');
  if (hostname.length === 0 || hostname.length > 253) return fail('INVALID_DOMAIN');
  if (IPV4.test(hostname)) return fail('INVALID_DOMAIN');

  const labels = hostname.split('.');
  if (!labels.every((label) => LABEL.test(label))) return fail('INVALID_DOMAIN');
  if (labels.length < 2) return fail('INVALID_DOMAIN');

  const reserved = RESERVED_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  if (reserved) return fail('INVALID_DOMAIN');

  const lastTwo = labels.slice(-2).join('.');
  const registrableLabels = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length <= registrableLabels) return fail('ROOT_DOMAIN');

  return { ok: true };
}

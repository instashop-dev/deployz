/**
 * Route53 CNAME record writer — the ONLY Route53 surface the control plane
 * has, and the only new control-plane surface Phase 11 adds.
 *
 * Why it talks to Route53 directly instead of through an AWS SDK client:
 * `@aws-sdk/client-route-53` is not installed anywhere in this workspace and
 * Phase 11 must not add a dependency, so the two operations the default-HTTPS
 * feature needs (upsert a validation/routing CNAME, delete one) are signed
 * by hand with SigV4 (`node:crypto` only) and sent to the Route53 REST API.
 * This is deliberately NOT a general DNS platform — one record type, two
 * operations.
 *
 * Credentials come from the Lambda-provided `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` environment variables — the
 * same env-credential idiom apps/api/src/email.ts already uses for SES, kept
 * here because the API Lambda role (DeployzStack) carries the scoped
 * `route53:ChangeResourceRecordSets` grant this module needs.
 *
 * The signing steps are pure and unit-tested (`signV4` below); the fetch is
 * injectable so a test never leaves the machine.
 */

import { createHash, createHmac } from 'node:crypto';

// ── Injectable seam ──────────────────────────────────────────────────────────

export interface DnsRecordClient {
  /** Create or overwrite one CNAME record (Route53 UPSERT semantics). */
  upsertCname(name: string, value: string): Promise<void>;
  /** Delete one CNAME record; a record that is already gone is not an error. */
  deleteCname(name: string): Promise<void>;
}

/** A no-op writer — DNS fixture mode, where records are declared, not real. */
export const noopDnsRecordClient: DnsRecordClient = {
  async upsertCname() {},
  async deleteCname() {},
};

// ── SigV4 (pure, unit-tested) ────────────────────────────────────────────────

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Derives the SigV4 signing key for one (date, region, service). */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Builds the `Authorization` header for one SigV4 request. Route53's REST API
 * takes no query string, so the canonical request is fixed-shape: the XML body
 * is the only content that varies.
 */
export function signV4(params: {
  method: 'POST' | 'GET' | 'DELETE';
  /** Canonical URI path, e.g. `/2013-04-01/hostedzone/ZONEID/rrset/`. */
  path: string;
  payload: string;
  credentials: SigV4Credentials;
  now?: Date;
  region?: string;
  service?: string;
}): { authorization: string; amzDate: string; dateStamp: string; payloadHash: string } {
  const { method, path, payload, credentials } = params;
  const now = params.now ?? new Date();
  const region = params.region ?? 'us-east-1'; // Route53 is global; SigV4 still uses us-east-1.
  const service = params.service ?? 'route53';

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);

  const host = 'route53.amazonaws.com';
  const headers: Record<string, string> = {
    'content-type': 'application/xml',
    host,
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };
  const signedHeaderNames = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}`)
    .join('\n');

  const canonicalRequest = [
    method,
    path,
    '', // canonical query string
    `${canonicalHeaders}\n`,
    signedHeaderNames,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign).toString('hex');

  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    amzDate,
    dateStamp,
    payloadHash,
  };
}

// ── Route53 request bodies ───────────────────────────────────────────────────

/** XML body of a single UPSERT/DELETE ChangeResourceRecordSets request. */
export function changeRecordSetBody(
  action: 'UPSERT' | 'DELETE',
  name: string,
  value?: string,
): string {
  const record = value
    ? `<ResourceRecord><Value>${escapeXml(value)}</Value></ResourceRecord>`
    : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">' +
    '<ChangeBatch><Changes><Change>' +
    `<Action>${action}</Action>` +
    `<ResourceRecordSet><Name>${escapeXml(name)}</Name><Type>CNAME</Type><TTL>60</TTL>` +
    (record ? `<ResourceRecords>${record}</ResourceRecords>` : '') +
    '</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>'
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Whether a Route53 error response body reports the record as missing. */
export function isInvalidChangeBatch(body: string): boolean {
  return body.includes('<Code>InvalidChangeBatch</Code>');
}

/** A DELETE for a record that never existed is InvalidChangeBatch (HTTP 400),
 *  NOT an access-denied. */
function isNotFoundStatus(status: number, body: string): boolean {
  return status === 400 && isInvalidChangeBatch(body);
}

// ── Real writer ──────────────────────────────────────────────────────────────

const HOSTED_ZONE_PATH_PREFIX = '/2013-04-01/hostedzone/';
const RR_SET_SUFFIX = '/rrset/';

export interface Route53RecordWriterOptions {
  readonly hostedZoneId: string;
  /** Injectable fetch — defaults to global fetch (Node 22). */
  readonly fetchFn?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;
  /** Injectable credentials for tests; defaults to the Lambda env vars. */
  readonly credentials?: SigV4Credentials;
  /** Injectable clock for deterministic signatures in tests. */
  readonly now?: () => Date;
}

interface ResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

async function readResponseBody(response: ResponseLike): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Real Route53-backed writer. Constructed only when a zone is configured —
 *  an unconfigured zone id means the feature is off and this is never built. */
export function createRoute53RecordClient(options: Route53RecordWriterOptions): DnsRecordClient {
  const { hostedZoneId } = options;
  const fetchFn =
    options.fetchFn ??
    (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
      globalThis.fetch(url, init));
  const credentials =
    options.credentials ??
    ((): SigV4Credentials => {
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? '';
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? '';
      const sessionToken = process.env.AWS_SESSION_TOKEN;
      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          'Route53 record writer requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (Lambda provides them)',
        );
      }
      return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
    })();

  const path = `${HOSTED_ZONE_PATH_PREFIX}${hostedZoneId}${RR_SET_SUFFIX}`;
  const url = `https://route53.amazonaws.com${path}`;

  async function send(action: 'UPSERT' | 'DELETE', name: string, value?: string): Promise<void> {
    const payload = changeRecordSetBody(action, name, value);
    const now = options.now?.();
    const signature = signV4({
      method: 'POST',
      path,
      payload,
      credentials,
      ...(now ? { now } : {}),
    });
    const response = (await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        'X-Amz-Date': signature.amzDate,
        Authorization: signature.authorization,
        ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
      },
      body: payload,
    })) as unknown as ResponseLike;
    const status = response.status;
    if (status >= 200 && status < 300) return;
    const body = await readResponseBody(response);
    if (action === 'DELETE' && isNotFoundStatus(status, body)) return;
    throw new Error(`Route53 ${action} of ${name} failed (HTTP ${status}): ${body.slice(0, 300)}`);
  }

  return {
    upsertCname: (name, value) => send('UPSERT', name, value),
    deleteCname: (name) => send('DELETE', name),
  };
}

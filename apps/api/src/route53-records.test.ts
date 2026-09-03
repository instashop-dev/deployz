import { describe, expect, it } from 'vitest';

import {
  changeRecordSetBody,
  createRoute53RecordClient,
  deriveSigningKey,
  isInvalidChangeBatch,
  signV4,
  type DnsRecordClient,
} from './route53-records.js';

// Phase 11 — the control plane's Route53 record surface. Pure unit tests:
// the SigV4 signature, the XML bodies, and the not-found semantics all run
// against fakes; no request ever leaves the machine.

describe('signV4', () => {
  const credentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };

  it('is deterministic for identical inputs', () => {
    const first = signV4({
      method: 'POST',
      path: '/2013-04-01/hostedzone/Z0123/rrset/',
      payload: '<x/>',
      credentials,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const second = signV4({
      method: 'POST',
      path: '/2013-04-01/hostedzone/Z0123/rrset/',
      payload: '<x/>',
      credentials,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(first).toEqual(second);
  });

  it('produces a 64-hex signature with the expected credential scope', () => {
    const signed = signV4({
      method: 'POST',
      path: '/2013-04-01/hostedzone/Z0123/rrset/',
      payload: '<x/>',
      credentials,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(signed.dateStamp).toBe('20260101');
    expect(signed.authorization).toContain(
      'Credential=AKIDEXAMPLE/20260101/us-east-1/route53/aws4_request',
    );
    const signature = signed.authorization.match(/Signature=([0-9a-f]{64})/);
    expect(signature).not.toBeNull();
  });

  it('derives the documented SigV4 signing key shape (starts from AWS4 + secret)', () => {
    const key = deriveSigningKey('secret', '20260101', 'us-east-1', 'route53');
    expect(key.length).toBe(32);
    // Determinism: the same inputs produce the same key.
    expect(deriveSigningKey('secret', '20260101', 'us-east-1', 'route53').equals(key)).toBe(true);
    expect(deriveSigningKey('other', '20260101', 'us-east-1', 'route53').equals(key)).toBe(false);
  });

  it('adds the session-token header when credentials carry one', () => {
    const signed = signV4({
      method: 'POST',
      path: '/2013-04-01/hostedzone/Z0123/rrset/',
      payload: '',
      credentials: { ...credentials, sessionToken: 'tok' },
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(signed.authorization).toContain('x-amz-security-token');
  });
});

describe('changeRecordSetBody', () => {
  it('builds an UPSERT body with the record value and a CNAME type', () => {
    const body = changeRecordSetBody('UPSERT', '_abc.d-dep.deployz.dev', '_xyz.acm-validations.aws.');
    expect(body).toContain('<Action>UPSERT</Action>');
    expect(body).toContain('<Name>_abc.d-dep.deployz.dev</Name>');
    expect(body).toContain('<Type>CNAME</Type>');
    expect(body).toContain('<Value>_xyz.acm-validations.aws.</Value>');
  });

  it('builds a DELETE body with no ResourceRecords', () => {
    const body = changeRecordSetBody('DELETE', '_abc.d-dep.deployz.dev');
    expect(body).toContain('<Action>DELETE</Action>');
    expect(body).not.toContain('<ResourceRecords>');
  });

  it('escapes XML metacharacters in names and values', () => {
    const body = changeRecordSetBody('UPSERT', 'a&b.dev', 'v<v>');
    expect(body).toContain('a&amp;b.dev');
    expect(body).toContain('v&lt;v&gt;');
  });
});

describe('createRoute53RecordClient', () => {
  function fakeFetch(handler: (url: string, init: { body: string }) => { status: number; body?: string }) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const client = createRoute53RecordClient({
      hostedZoneId: 'Z0123',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      now: () => new Date('2026-01-01T00:00:00Z'),
      fetchFn: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        const result = handler(url, init);
        return { status: result.status, text: async () => result.body ?? '' };
      },
    });
    return { calls, client: client as DnsRecordClient };
  }

  it('upserts against the hosted-zone rrset endpoint with SigV4 headers', async () => {
    const { calls, client } = fakeFetch(() => ({ status: 200 }));
    await client.upsertCname('_abc.d-dep.deployz.dev', '_xyz.acm-validations.aws.');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://route53.amazonaws.com/2013-04-01/hostedzone/Z0123/rrset/');
    expect(calls[0]!.headers['Content-Type']).toBe('application/xml');
    expect(calls[0]!.headers['X-Amz-Date']).toBe('20260101T000000Z');
    expect(calls[0]!.headers['Authorization']).toContain('Signature=');
    expect(calls[0]!.body).toContain('<Action>UPSERT</Action>');
  });

  it('a delete of an already-gone record (HTTP 400 InvalidChangeBatch) is not an error', async () => {
    const { client } = fakeFetch(() => ({
      status: 400,
      body:
        '<?xml version="1.0"?><ErrorResponse><Error><Code>InvalidChangeBatch</Code>' +
        '<Message>record not found</Message></Error></ErrorResponse>',
    }));
    await expect(client.deleteCname('d-gone.deployz.dev')).resolves.toBeUndefined();
  });

  it('propagates real failures (403 access denied) instead of swallowing them', async () => {
    const { client } = fakeFetch(() => ({
      status: 403,
      body: '<?xml version="1.0"?><ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>',
    }));
    await expect(client.upsertCname('d-x.deployz.dev', 'y')).rejects.toThrow();
    await expect(client.deleteCname('d-x.deployz.dev')).rejects.toThrow();
  });

  it('isInvalidChangeBatch matches the Route53 error body', () => {
    expect(
      isInvalidChangeBatch(
        '<?xml version="1.0"?><ErrorResponse><Error><Code>InvalidChangeBatch</Code></Error></ErrorResponse>',
      ),
    ).toBe(true);
    expect(isInvalidChangeBatch('<Error><Code>AccessDenied</Code></Error>')).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { AcmCertificateStatus } from '@deployz/contracts';

import type { RelayCommand } from './commands.js';
import type { ElbClient, ListenerInfo, LoadBalancerInfo } from './domain.js';
import { createRegionalCertificateExecutors, type RegionalAcmClient } from './regional-certificate.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakeCertificate {
  status: AcmCertificateStatus;
  validationRecord?: { name: string; value: string; type: string };
  failureReason?: string;
}

class FakeRegionalAcmClient implements RegionalAcmClient {
  certificates = new Map<string, FakeCertificate>();
  /** arn -> remaining describeCertificate calls to withhold the validation record for. */
  delayValidationRecord = new Map<string, number>();
  describeCalls: string[] = [];
  taggedCandidates: Array<{ arn: string; status: AcmCertificateStatus }> = [];
  findCertificatesByTagCalls: Array<{ domain: string; tagKey: string; tagValue: string }> = [];
  requestCalls: Array<{ domainName: string; idempotencyToken: string; tags: Record<string, string> }> = [];
  requestError: Error | undefined;
  deleteCalls: string[] = [];
  #arnCounter = 0;

  async describeCertificate(arn: string): Promise<FakeCertificate | null> {
    this.describeCalls.push(arn);
    const cert = this.certificates.get(arn);
    if (!cert) return null;
    const delay = this.delayValidationRecord.get(arn) ?? 0;
    if (delay > 0) {
      this.delayValidationRecord.set(arn, delay - 1);
      const { validationRecord: _validationRecord, ...withoutRecord } = cert;
      return withoutRecord;
    }
    return cert;
  }

  async findCertificatesByTag(
    domain: string,
    tagKey: string,
    tagValue: string,
  ): Promise<Array<{ arn: string; status: AcmCertificateStatus }>> {
    this.findCertificatesByTagCalls.push({ domain, tagKey, tagValue });
    return this.taggedCandidates;
  }

  async requestCertificate(p: {
    domainName: string;
    idempotencyToken: string;
    tags: Record<string, string>;
  }): Promise<string> {
    this.requestCalls.push(p);
    if (this.requestError) throw this.requestError;
    const arn = `arn:aws:acm:us-east-1:123456789012:certificate/new-${this.#arnCounter++}`;
    if (!this.certificates.has(arn)) {
      this.certificates.set(arn, { status: 'PENDING_VALIDATION' });
    }
    return arn;
  }

  async deleteCertificate(arn: string): Promise<void> {
    this.deleteCalls.push(arn);
    this.certificates.delete(arn);
  }
}

class FakeElbClient implements ElbClient {
  loadBalancer: LoadBalancerInfo | undefined;
  listeners: ListenerInfo[] = [];
  targetGroups: string[] = [];

  createHttpsListenerCalls: Array<{
    loadBalancerArn: string;
    certificateArn: string;
    targetGroupArn: string;
    tagKey: string;
    tagValue: string;
  }> = [];
  ensureListenerTagCalls: Array<{ listenerArn: string; tagKey: string; tagValue: string }> = [];
  addListenerCertificateCalls: Array<{ listenerArn: string; certificateArn: string }> = [];
  setHttpRedirectCalls: string[] = [];
  callLog: string[] = [];

  /** Simulates AWS: once createHttpsListener runs, a later describeListeners sees it. */
  #createdListenerArn: string | undefined;

  async findTaggedLoadBalancer(): Promise<LoadBalancerInfo | undefined> {
    return this.loadBalancer;
  }

  async describeListeners(): Promise<ListenerInfo[]> {
    if (this.#createdListenerArn && !this.listeners.some((listener) => listener.port === 443)) {
      return [
        ...this.listeners,
        { arn: this.#createdListenerArn, port: 443, redirectsToHttps: false },
      ];
    }
    return this.listeners;
  }

  async describeTargetGroups(): Promise<string[]> {
    return this.targetGroups;
  }

  async createHttpsListener(p: {
    loadBalancerArn: string;
    certificateArn: string;
    targetGroupArn: string;
    tagKey: string;
    tagValue: string;
  }): Promise<void> {
    this.createHttpsListenerCalls.push(p);
    this.#createdListenerArn = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/lb/1/https';
  }

  async ensureListenerTag(listenerArn: string, tagKey: string, tagValue: string): Promise<void> {
    this.ensureListenerTagCalls.push({ listenerArn, tagKey, tagValue });
    this.callLog.push('ensureListenerTag');
  }

  async addListenerCertificate(listenerArn: string, certificateArn: string): Promise<void> {
    this.addListenerCertificateCalls.push({ listenerArn, certificateArn });
    this.callLog.push('addListenerCertificate');
  }

  async removeListenerCertificate(): Promise<void> {}

  async deleteListener(): Promise<void> {}

  async setHttpRedirect(listenerArn: string): Promise<void> {
    this.setHttpRedirectCalls.push(listenerArn);
  }

  async setHttpForward(): Promise<void> {}
}

function ensureCommand(payload: Record<string, unknown>): RelayCommand {
  return {
    id: 'cmd-ensure-1',
    deploymentId: 'dep-1',
    type: 'ENSURE_CERTIFICATE',
    idempotencyKey: 'dep-1:ENSURE_CERTIFICATE',
    payload,
  };
}

function attachCommand(payload: Record<string, unknown>): RelayCommand {
  return {
    id: 'cmd-attach-1',
    deploymentId: 'dep-1',
    type: 'ATTACH_CERTIFICATE',
    idempotencyKey: 'dep-1:ATTACH_CERTIFICATE',
    payload,
  };
}

const DOMAIN = '*.c-scope123abc.deployz.dev';
const SCOPE = 'scope123abc';

// ── ENSURE_CERTIFICATE ───────────────────────────────────────────────────────

describe('ENSURE_CERTIFICATE', () => {
  it('requests a new certificate (with tags + idempotency token) and waits for the DNS validation record', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    const sleep = vi.fn(async () => {});
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1', sleep });

    // The fake mints `new-0` for the first request — pre-seed it so the
    // record only appears after a couple of describes, exercising the
    // "wait for the validation record" loop.
    const arn = 'arn:aws:acm:us-east-1:123456789012:certificate/new-0';
    acm.certificates.set(arn, {
      status: 'PENDING_VALIDATION',
      validationRecord: { name: '_abc.c-scope123abc.deployz.dev.', value: 'val.acm-validations.aws.', type: 'CNAME' },
    });
    acm.delayValidationRecord.set(arn, 2);

    const result = await executors.ENSURE_CERTIFICATE(
      ensureCommand({ certificateDomain: DOMAIN, customerScope: SCOPE, idempotencyToken: 'idemtoken1' }),
    );

    expect(acm.requestCalls).toEqual([
      {
        domainName: DOMAIN,
        idempotencyToken: 'idemtoken1',
        tags: {
          // The requesting relay's own installation tag rides along (IAM
          // policy-size constraint) — RequestCertificate is authorized
          // through the installation-tag statement, not the scope one.
          'deployz:installation': 'inst-1',
          'deployz:customer-scope': SCOPE,
          'deployz:component': 'regional-tls',
          'deployz:managed-by': 'deployz',
        },
      },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      certificateArn: arn,
      certificateStatus: 'PENDING_VALIDATION',
      validationRecordName: '_abc.c-scope123abc.deployz.dev.',
      validationRecordValue: 'val.acm-validations.aws.',
      validationRecordType: 'CNAME',
    });
  });

  it('uses a stored ISSUED arn as-is: describes it, never requests or adopts', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1', sleep: async () => {} });
    const arn = 'arn:aws:acm:us-east-1:123456789012:certificate/stored-issued';
    acm.certificates.set(arn, { status: 'ISSUED' });

    const result = await executors.ENSURE_CERTIFICATE(
      ensureCommand({ certificateDomain: DOMAIN, customerScope: SCOPE, certificateArn: arn, idempotencyToken: 'idemtoken1' }),
    );

    expect(acm.requestCalls).toHaveLength(0);
    expect(acm.findCertificatesByTagCalls).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ certificateArn: arn, certificateStatus: 'ISSUED' });
    expect(result.output).not.toHaveProperty('adopted');
  });

  it('adopts a tagged certificate by scope when the stored arn no longer describes', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1', sleep: async () => {} });
    const adoptedArn = 'arn:aws:acm:us-east-1:123456789012:certificate/adopted';
    acm.certificates.set(adoptedArn, {
      status: 'PENDING_VALIDATION',
      validationRecord: { name: '_abc.example.', value: 'val.', type: 'CNAME' },
    });
    acm.taggedCandidates = [{ arn: adoptedArn, status: 'PENDING_VALIDATION' }];

    const result = await executors.ENSURE_CERTIFICATE(
      ensureCommand({
        certificateDomain: DOMAIN,
        customerScope: SCOPE,
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/gone',
        idempotencyToken: 'idemtoken1',
      }),
    );

    expect(acm.requestCalls).toHaveLength(0);
    expect(acm.findCertificatesByTagCalls).toEqual([
      { domain: DOMAIN, tagKey: 'deployz:customer-scope', tagValue: SCOPE },
    ]);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ certificateArn: adoptedArn, adopted: true });
  });

  it('requests a new certificate when the stored arn is gone and nothing is tagged for this scope', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1', sleep: async () => {} });

    const result = await executors.ENSURE_CERTIFICATE(
      ensureCommand({
        certificateDomain: DOMAIN,
        customerScope: SCOPE,
        certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/gone',
        idempotencyToken: 'idemtoken1',
      }),
    );

    expect(acm.requestCalls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.output).not.toHaveProperty('adopted');
  });

  it('does not request again for a stored certificate that is still PENDING_VALIDATION', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1', sleep: async () => {} });
    const arn = 'arn:aws:acm:us-east-1:123456789012:certificate/still-pending';
    acm.certificates.set(arn, {
      status: 'PENDING_VALIDATION',
      validationRecord: { name: '_abc.example.', value: 'val.', type: 'CNAME' },
    });

    const result = await executors.ENSURE_CERTIFICATE(
      ensureCommand({ certificateDomain: DOMAIN, customerScope: SCOPE, certificateArn: arn, idempotencyToken: 'idemtoken1' }),
    );

    expect(acm.requestCalls).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ certificateArn: arn, certificateStatus: 'PENDING_VALIDATION' });
  });

  it('reports a FAILED certificate as a successful command result carrying the failure reason', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1', sleep: async () => {} });
    const arn = 'arn:aws:acm:us-east-1:123456789012:certificate/failed';
    acm.certificates.set(arn, { status: 'FAILED', failureReason: 'CAA_ERROR' });

    const result = await executors.ENSURE_CERTIFICATE(
      ensureCommand({ certificateDomain: DOMAIN, customerScope: SCOPE, certificateArn: arn, idempotencyToken: 'idemtoken1' }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ certificateArn: arn, certificateStatus: 'FAILED', failureReason: 'CAA_ERROR' });
  });

  it('reports AWS_PERMISSION_DENIED when the tag lookup is access-denied', async () => {
    const acm = new FakeRegionalAcmClient();
    acm.findCertificatesByTag = async () => {
      throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    };
    const elb = new FakeElbClient();
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1', sleep: async () => {} });

    const result = await executors.ENSURE_CERTIFICATE(
      ensureCommand({ certificateDomain: DOMAIN, customerScope: SCOPE, idempotencyToken: 'idemtoken1' }),
    );

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('AWS_PERMISSION_DENIED');
  });

  it('rejects a malformed payload without touching AWS', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1', sleep: async () => {} });

    const result = await executors.ENSURE_CERTIFICATE(ensureCommand({ certificateDomain: DOMAIN }));

    expect(result.success).toBe(false);
    expect(acm.requestCalls).toHaveLength(0);
  });
});

// ── ATTACH_CERTIFICATE ───────────────────────────────────────────────────────

describe('ATTACH_CERTIFICATE', () => {
  it('creates the 443 listener and redirects 80 when neither exists', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    elb.loadBalancer = { arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/lb/1', dnsName: 'app-alb.us-east-1.elb.amazonaws.com' };
    elb.listeners = [{ arn: 'listener-80', port: 80, redirectsToHttps: false }];
    elb.targetGroups = ['tg-1'];
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1' });

    const result = await executors.ATTACH_CERTIFICATE(
      attachCommand({ certificateArn: 'arn-x', hostname: 'd-1.c-scope123abc.deployz.dev' }),
    );

    expect(elb.createHttpsListenerCalls).toEqual([
      {
        loadBalancerArn: elb.loadBalancer.arn,
        certificateArn: 'arn-x',
        targetGroupArn: 'tg-1',
        tagKey: 'deployz:installation',
        tagValue: 'inst-1',
      },
    ]);
    expect(elb.setHttpRedirectCalls).toEqual(['listener-80']);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      routingTarget: 'app-alb.us-east-1.elb.amazonaws.com',
      httpsConfigured: true,
      listenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/lb/1/https',
    });
  });

  it('adds the certificate to an existing 443 listener whose default certificate differs', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    elb.loadBalancer = { arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/lb/1', dnsName: 'app-alb.us-east-1.elb.amazonaws.com' };
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn-old', redirectsToHttps: true },
      { arn: 'listener-80', port: 80, redirectsToHttps: true },
    ];
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1' });

    const result = await executors.ATTACH_CERTIFICATE(
      attachCommand({ certificateArn: 'arn-new', hostname: 'd-1.c-scope123abc.deployz.dev' }),
    );

    expect(elb.callLog).toEqual(['ensureListenerTag', 'addListenerCertificate']);
    expect(elb.addListenerCertificateCalls).toEqual([{ listenerArn: 'listener-443', certificateArn: 'arn-new' }]);
    // 80 already redirects — no redundant ModifyListener call.
    expect(elb.setHttpRedirectCalls).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ httpsConfigured: true, listenerArn: 'listener-443' });
  });

  it('is idempotent: repeating the attach against an already-wired listener makes no further changes', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    elb.loadBalancer = { arn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/lb/1', dnsName: 'app-alb.us-east-1.elb.amazonaws.com' };
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn-x', redirectsToHttps: true },
      { arn: 'listener-80', port: 80, redirectsToHttps: true },
    ];
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1' });
    const payload = attachCommand({ certificateArn: 'arn-x', hostname: 'd-1.c-scope123abc.deployz.dev' });

    const first = await executors.ATTACH_CERTIFICATE(payload);
    const second = await executors.ATTACH_CERTIFICATE({ ...payload, id: 'cmd-attach-2', idempotencyKey: 'dep-1:ATTACH_CERTIFICATE:2' });

    expect(elb.ensureListenerTagCalls).toHaveLength(0);
    expect(elb.addListenerCertificateCalls).toHaveLength(0);
    expect(elb.createHttpsListenerCalls).toHaveLength(0);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.output).toMatchObject({ httpsConfigured: true });
    expect(second.output).toMatchObject({ httpsConfigured: true });
  });

  it('fails with UNKNOWN when this installation has no ALB yet', async () => {
    const acm = new FakeRegionalAcmClient();
    const elb = new FakeElbClient();
    elb.loadBalancer = undefined;
    const executors = createRegionalCertificateExecutors({ acm, elb, installationId: 'inst-1' });

    const result = await executors.ATTACH_CERTIFICATE(
      attachCommand({ certificateArn: 'arn-x', hostname: 'd-1.c-scope123abc.deployz.dev' }),
    );

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('UNKNOWN');
    expect(result.error).toContain('inst-1');
  });
});

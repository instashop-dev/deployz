/**
 * Simulated ACM certificate registry for the regional HTTPS E2E harness
 * (docs/https-regional-certificates.md, e2e/scenario-regional-https.spec.ts).
 *
 * Models ACM's real two-phase DNS-01 issuance flow at the level the relay's
 * ENSURE_CERTIFICATE/ATTACH_CERTIFICATE commands see it — mirroring
 * packages/relay/src/regional-certificate.ts's `ensureCertificate` executor
 * (describe a stored ARN -> adopt a matching tagged certificate -> request a
 * fresh one) without touching the real AWS SDK:
 *
 *  - The FIRST `ensure()` for a (region, certificateDomain) pair with no
 *    describable stored ARN requests a NEW certificate and reports
 *    `PENDING_VALIDATION` with the scope validation record.
 *  - A LATER `ensure()` that resolves to the SAME certificate (by stored ARN,
 *    or by adopting the one already on record for that domain+region)
 *    reports `ISSUED`.
 *  - A call whose stored ARN was deleted from the registry (`forget`, or the
 *    one-shot `forgetNextRequested` test hook) requests a brand new
 *    certificate, exactly like a real out-of-band deletion.
 *
 * Certificates are region-scoped, exactly like real ACM: two relays
 * enrolled in different regions for the same customer namespace never share
 * one, even though the certificate DOMAIN string (`*.c-<scope>.<apex>`) is
 * identical in both.
 *
 * A single registry instance is shared across every `startSimulatedRelay`
 * call for deployments that belong to the same simulated customer AWS
 * account, so sibling relays (a second deployment in the same scope, or a
 * relay in a different region) observe the same certificate state a real
 * shared ACM account would. The Playwright test process and the harness's
 * relay code run in the same Node process, so specs read this registry
 * directly (no HTTP round trip, unlike the default-DNS fixture which lives
 * in the separate API server process).
 */

import type { AcmCertificateStatus } from '@deployz/contracts';

/** One simulated ACM certificate. */
export interface SimulatedAcmCertificate {
  readonly arn: string;
  readonly domain: string;
  readonly region: string;
  readonly customerScope: string;
  readonly status: AcmCertificateStatus;
  readonly validationRecordName?: string;
  readonly validationRecordValue?: string;
  readonly failureReason?: string;
  readonly attached: boolean;
}

/** One ENSURE_CERTIFICATE/ATTACH_CERTIFICATE/delete call this registry
 *  observed, in order — for scenario assertions (e.g. "exactly one ENSURE
 *  request"). */
export interface SimulatedAcmMutation {
  readonly op: 'ENSURE_CERTIFICATE' | 'ATTACH_CERTIFICATE' | 'DELETE_CERTIFICATE';
  /** requested | issued | adopted | described | failed | attached | deleted */
  readonly outcome: string;
  readonly domain: string;
  readonly region: string;
  readonly arn: string;
}

export interface EnsureCertificateInput {
  readonly certificateDomain: string;
  readonly customerScope: string;
  readonly region: string;
  readonly certificateArn?: string;
}

export interface EnsureCertificateOutcome {
  readonly certificateArn: string;
  readonly certificateStatus: AcmCertificateStatus;
  readonly validationRecordName?: string;
  readonly validationRecordValue?: string;
  readonly validationRecordType?: string;
  readonly failureReason?: string;
  readonly adopted?: boolean;
}

interface MutableCertificate {
  arn: string;
  domain: string;
  region: string;
  customerScope: string;
  status: AcmCertificateStatus;
  validationRecordName?: string;
  validationRecordValue?: string;
  failureReason?: string;
  attached: boolean;
}

/** Fixed validation record content — matches ACM's real DNS-01 shape
 *  (`_<digest>.c-<scope>.<zone>`, one label under the customer namespace,
 *  trailing dot) without randomizing per certificate; the fixture DNS
 *  writer's upsert is idempotent on (name, value), so re-requesting the same
 *  name/value across a forgotten-then-replaced certificate is harmless. */
const VALIDATION_RECORD_LABEL = '_e2e';
const VALIDATION_RECORD_VALUE = '_e2e-validate.acm-validations.aws.';

export class SimulatedAcmRegistry {
  private readonly byArn = new Map<string, MutableCertificate>();
  private readonly mutationLogEntries: SimulatedAcmMutation[] = [];
  /** One-shot scripted FAILED outcome for the next fresh request matching
   *  (region, domain) — RF (failure UX). */
  private readonly scriptedFailures = new Map<string, string>();
  /** One-shot: forget the very next freshly-requested certificate
   *  immediately after minting it — RE (recovery). */
  private forgetNextOnce = false;
  private serial = 1;

  private key(region: string, domain: string): string {
    return `${region}::${domain.toLowerCase()}`;
  }

  /** Scripts the next fresh certificate requested for (region, domain) to
   *  report FAILED with `failureReason`. One-shot — a later retry's fresh
   *  request issues normally. */
  scriptFailure(region: string, domain: string, failureReason: string): void {
    this.scriptedFailures.set(this.key(region, domain), failureReason);
  }

  /** RE (recovery): the NEXT certificate this registry mints (from any
   *  `ensure()` call that ends up requesting a fresh one) is deleted right
   *  after being minted — before `ensure()` returns — so the caller sees it
   *  reported once and then genuinely gone, no timing race with the relay's
   *  own poll cycle. */
  forgetNextRequested(): void {
    this.forgetNextOnce = true;
  }

  /** Deletes a certificate out of band — the next `ensure()` call whose
   *  stored ARN pointed at it requests a fresh replacement. Mirrors ACM
   *  `DeleteCertificate`/an out-of-band console deletion. */
  forget(certificateArn: string): void {
    const cert = this.byArn.get(certificateArn);
    if (!cert) return;
    this.byArn.delete(certificateArn);
  }

  /** Mirrors packages/relay/src/regional-certificate.ts's `ensureCertificate`
   *  executor: describe a stored ARN, else adopt a live certificate already
   *  on record for this domain+region, else request a fresh one. */
  ensure(input: EnsureCertificateInput): EnsureCertificateOutcome {
    let cert = input.certificateArn ? this.byArn.get(input.certificateArn) : undefined;
    let adopted = false;
    if (!cert) {
      cert = [...this.byArn.values()].find(
        (candidate) =>
          candidate.domain.toLowerCase() === input.certificateDomain.toLowerCase() &&
          candidate.region === input.region &&
          candidate.status !== 'FAILED',
      );
      if (cert) adopted = true;
    }

    if (!cert) {
      const key = this.key(input.region, input.certificateDomain);
      const scriptedFailure = this.scriptedFailures.get(key);
      if (scriptedFailure) this.scriptedFailures.delete(key);

      const arn = `arn:aws:acm:${input.region}:123456789012:certificate/sim-regional-${this.serial++}`;
      // Exactly one label under the customer namespace, trailing dot to
      // mirror ACM's own FQDN validation-record shape
      // (isScopeValidationRecordName, docs/https-regional-certificates.md).
      const namespaceSuffix = input.certificateDomain.startsWith('*.')
        ? input.certificateDomain.slice(2)
        : input.certificateDomain;
      const created: MutableCertificate = {
        arn,
        domain: input.certificateDomain,
        region: input.region,
        customerScope: input.customerScope,
        status: scriptedFailure ? 'FAILED' : 'PENDING_VALIDATION',
        ...(scriptedFailure
          ? { failureReason: scriptedFailure }
          : {
              validationRecordName: `${VALIDATION_RECORD_LABEL}.${namespaceSuffix}.`,
              validationRecordValue: VALIDATION_RECORD_VALUE,
            }),
        attached: false,
      };
      this.byArn.set(arn, created);
      this.mutationLogEntries.push({
        op: 'ENSURE_CERTIFICATE',
        outcome: scriptedFailure ? 'failed' : 'requested',
        domain: created.domain,
        region: created.region,
        arn,
      });

      if (this.forgetNextOnce) {
        this.forgetNextOnce = false;
        this.byArn.delete(arn);
      }

      return this.toOutcome(created, false);
    }

    if (cert.status === 'PENDING_VALIDATION') {
      cert.status = 'ISSUED';
      this.mutationLogEntries.push({
        op: 'ENSURE_CERTIFICATE',
        outcome: 'issued',
        domain: cert.domain,
        region: cert.region,
        arn: cert.arn,
      });
    } else {
      this.mutationLogEntries.push({
        op: 'ENSURE_CERTIFICATE',
        outcome: adopted ? 'adopted' : 'described',
        domain: cert.domain,
        region: cert.region,
        arn: cert.arn,
      });
    }
    return this.toOutcome(cert, adopted);
  }

  private toOutcome(cert: MutableCertificate, adopted: boolean): EnsureCertificateOutcome {
    return {
      certificateArn: cert.arn,
      certificateStatus: cert.status,
      ...(cert.validationRecordName && cert.status === 'PENDING_VALIDATION'
        ? {
            validationRecordName: cert.validationRecordName,
            validationRecordValue: cert.validationRecordValue,
            validationRecordType: 'CNAME',
          }
        : {}),
      ...(cert.failureReason ? { failureReason: cert.failureReason } : {}),
      ...(adopted ? { adopted: true } : {}),
    };
  }

  /** Mirrors `attachCertificateToLoadBalancer` — wires the certificate into
   *  the (simulated) ALB listener. Throws on an unknown ARN, same as a real
   *  ELB `AddListenerCertificates` against a certificate that no longer
   *  exists. */
  attach(certificateArn: string, installationId: string): { routingTarget: string; httpsConfigured: boolean } {
    const cert = this.byArn.get(certificateArn);
    if (!cert) {
      throw new Error(`SimulatedAcmRegistry: cannot attach unknown certificate ${certificateArn}`);
    }
    cert.attached = true;
    this.mutationLogEntries.push({
      op: 'ATTACH_CERTIFICATE',
      outcome: 'attached',
      domain: cert.domain,
      region: cert.region,
      arn: cert.arn,
    });
    return {
      routingTarget: `e2e-regional-alb-${installationId}.deployz-fixture.test`,
      httpsConfigured: true,
    };
  }

  /** Mirrors the relay's PURGE executor deleting the ARNs the control plane
   *  listed in the `regionalCertificates` payload. Tolerates an already-gone
   *  ARN, same as real ACM `DeleteCertificate`. */
  delete(certificateArn: string): void {
    const cert = this.byArn.get(certificateArn);
    if (!cert) return;
    this.byArn.delete(certificateArn);
    this.mutationLogEntries.push({
      op: 'DELETE_CERTIFICATE',
      outcome: 'deleted',
      domain: cert.domain,
      region: cert.region,
      arn: cert.arn,
    });
  }

  certificates(): readonly SimulatedAcmCertificate[] {
    return [...this.byArn.values()].map((cert) => ({ ...cert }));
  }

  certificatesFor(region: string, domain: string): readonly SimulatedAcmCertificate[] {
    return this.certificates().filter(
      (cert) => cert.region === region && cert.domain.toLowerCase() === domain.toLowerCase(),
    );
  }

  mutationLog(): readonly SimulatedAcmMutation[] {
    return [...this.mutationLogEntries];
  }
}

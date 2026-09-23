/**
 * Regional HTTPS certificates — the customer-scoped wildcard ACM
 * certificate shared by every deployment in one customer + AWS account +
 * region (docs/https-regional-certificates.md). `domain.ts` keeps the
 * per-deployment/custom-domain flow; this module is the parallel flow for
 * the shared certificate, and reuses `domain.ts`'s `ElbClient` seam and
 * `ensureHttpsListener` listener-wiring so the two never drift apart.
 *
 * Same house idiom as `domain.ts`: a narrow injectable `RegionalAcmClient`
 * seam, a real SDK implementation constructed lazily, and in-memory fakes
 * in tests. `createRegionalCertificateExecutors` holds all the
 * orchestration logic and is exercised purely against fakes;
 * `createRealRegionalAcmClient` is the thin, untested-by-design real
 * implementation wired in `./index.ts`.
 */

import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';

import {
  DEPLOYZ_COMPONENT_TAG,
  DEPLOYZ_INSTALLATION_TAG,
  attachCertificatePayloadSchema,
  ensureCertificatePayloadSchema,
  type AcmCertificateStatus,
  type AttachCertificateResult,
  type EnsureCertificateResult,
} from '@deployz/contracts';

import type { CommandExecutor, RelayCommand, RelayCommandResult } from './commands.js';
import {
  CERTIFICATE_DELETE_RETRY_ATTEMPTS,
  CERTIFICATE_DELETE_RETRY_DELAY_MS,
  defaultSleep,
  ensureHttpsListener,
  isAccessDenied,
  isCertificateInUse,
  isNotFound,
  type ElbClient,
} from './domain.js';

/** Tags the customer-scoped wildcard certificate. It also carries the
 *  requester's `deployz:installation` tag (IAM policy-size constraint, see
 *  the request below); the purge sweep skips any certificate carrying this
 *  scope tag so no per-deployment teardown ever deletes the shared one. */
const CUSTOMER_SCOPE_TAG = 'deployz:customer-scope';
const MANAGED_BY_TAG = 'deployz:managed-by';

// ── Injectable AWS seam ──────────────────────────────────────────────────────

/** ACM operations the regional-certificate executors need. */
export interface RegionalAcmClient {
  /** Null on `ResourceNotFoundException` — an absent certificate is not an error here. */
  describeCertificate(arn: string): Promise<{
    status: AcmCertificateStatus;
    validationRecord?: { name: string; value: string; type: string };
    failureReason?: string;
  } | null>;
  /** Certificates for `domain` that carry `tagKey=tagValue`, newest ACM
   *  knowledge first is not guaranteed — callers pick by status. */
  findCertificatesByTag(
    domain: string,
    tagKey: string,
    tagValue: string,
  ): Promise<Array<{ arn: string; status: AcmCertificateStatus }>>;
  requestCertificate(p: {
    domainName: string;
    idempotencyToken: string;
    tags: Record<string, string>;
  }): Promise<string>; // arn
  deleteCertificate(arn: string): Promise<void>; // must swallow ResourceNotFoundException
}

interface RegionalCertificateExecutorDeps {
  acm: RegionalAcmClient;
  elb: ElbClient;
  installationId: string;
  /** Delay between validation-record polls. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

// A freshly requested certificate often has no validation record for the
// first few seconds — poll a few times before giving up and reporting
// PENDING_VALIDATION with no record yet.
const VALIDATION_RECORD_POLL_INTERVAL_MS = 5_000;
const VALIDATION_RECORD_MAX_POLLS = 6; // ~30s at 5s intervals

// ── ENSURE_CERTIFICATE ───────────────────────────────────────────────────────

async function ensureCertificate(
  command: RelayCommand,
  deps: RegionalCertificateExecutorDeps,
): Promise<RelayCommandResult> {
  const parsed = ensureCertificatePayloadSchema.safeParse(command.payload);
  if (!parsed.success) {
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      error: `Invalid ENSURE_CERTIFICATE payload: ${parsed.error.message}`,
      failureCode: 'UNKNOWN',
    };
  }
  const payload = parsed.data;
  const sleep = deps.sleep ?? defaultSleep;

  try {
    // (a) A stored ARN, when it still describes, is authoritative.
    let arn: string | undefined;
    let adopted = false;
    if (payload.certificateArn) {
      const described = await deps.acm.describeCertificate(payload.certificateArn);
      if (described) arn = payload.certificateArn;
    }

    // (b) No usable stored ARN — look for one already tagged for this
    // customer scope before requesting a new one (two first deployments in
    // the same scope must converge on one certificate).
    if (!arn) {
      const candidates = await deps.acm.findCertificatesByTag(
        payload.certificateDomain,
        CUSTOMER_SCOPE_TAG,
        payload.customerScope,
      );
      const found =
        candidates.find((c) => c.status === 'ISSUED') ??
        candidates.find((c) => c.status === 'PENDING_VALIDATION');
      if (found) {
        arn = found.arn;
        adopted = true;
      }
    }

    // (c) Nothing found — request a fresh one.
    if (!arn) {
      arn = await deps.acm.requestCertificate({
        domainName: payload.certificateDomain,
        idempotencyToken: payload.idempotencyToken,
        tags: {
          // IAM policy-size constraint: RequestCertificate is authorized
          // through the existing installation-tag ACM statement, so the
          // requesting relay's own installation tag rides along too — a
          // sibling relay in the same scope still finds/describes/deletes
          // it only through the customer-scope tag statement (never this
          // one). `findCertificatesByTag` matches on customer-scope alone.
          [DEPLOYZ_INSTALLATION_TAG]: deps.installationId,
          [CUSTOMER_SCOPE_TAG]: payload.customerScope,
          [DEPLOYZ_COMPONENT_TAG]: 'regional-tls',
          [MANAGED_BY_TAG]: 'deployz',
        },
      });
    }

    // (d) Describe until the validation record shows up or the budget runs out.
    let described = await deps.acm.describeCertificate(arn);
    for (
      let attempt = 1;
      described &&
      described.status === 'PENDING_VALIDATION' &&
      !described.validationRecord &&
      attempt < VALIDATION_RECORD_MAX_POLLS;
      attempt++
    ) {
      await sleep(VALIDATION_RECORD_POLL_INTERVAL_MS);
      described = await deps.acm.describeCertificate(arn);
    }

    if (!described) {
      // Vanished between the checks above and here (deleted out of band).
      return {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: false,
        error: `Certificate ${arn} could not be described`,
        failureCode: 'UNKNOWN',
      };
    }

    // (e) A FAILED/VALIDATION_TIMED_OUT certificate is still a SUCCESSFUL
    // command result — the control plane decides what to do with the
    // status and failureReason it carries.
    const output: EnsureCertificateResult = {
      certificateArn: arn,
      certificateStatus: described.status,
      ...(described.validationRecord
        ? {
            validationRecordName: described.validationRecord.name,
            validationRecordValue: described.validationRecord.value,
            validationRecordType: described.validationRecord.type,
          }
        : {}),
      ...(described.failureReason ? { failureReason: described.failureReason } : {}),
      ...(adopted ? { adopted: true } : {}),
    };

    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output,
    };
  } catch (err) {
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      error: String(err),
      failureCode: isAccessDenied(err) ? 'AWS_PERMISSION_DENIED' : 'UNKNOWN',
    };
  }
}

// ── ATTACH_CERTIFICATE ───────────────────────────────────────────────────────

export interface AttachRegionalCertificateDeps {
  elb: ElbClient;
  installationId: string;
}

/**
 * Wire an issued certificate into this relay's own ALB — finds it by tag,
 * then the shared listener wiring (`ensureHttpsListener`). This is the
 * operative half of the ATTACH_CERTIFICATE executor below, exported
 * separately so a verified INSTALL can call it directly (see
 * `./index.ts`'s `attachRegionalCertificate` wiring) without fabricating a
 * synthetic command — `hostname` in `AttachCertificatePayload` is carried
 * for the control plane's own bookkeeping and is not needed here. Throws on
 * failure; callers decide how to report that.
 */
export async function attachCertificateToLoadBalancer(
  deps: AttachRegionalCertificateDeps,
  certificateArn: string,
): Promise<AttachCertificateResult> {
  const loadBalancer = await deps.elb.findTaggedLoadBalancer(DEPLOYZ_INSTALLATION_TAG, deps.installationId);
  if (!loadBalancer) {
    throw new Error(
      `No load balancer tagged for installation ${deps.installationId} — infrastructure is not ready yet`,
    );
  }

  const wired = await ensureHttpsListener(deps.elb, {
    loadBalancerArn: loadBalancer.arn,
    certificateArn,
    tagKey: DEPLOYZ_INSTALLATION_TAG,
    tagValue: deps.installationId,
  });

  return {
    routingTarget: loadBalancer.dnsName,
    httpsConfigured: wired.httpsConfigured,
    ...(wired.listenerArn ? { listenerArn: wired.listenerArn } : {}),
  };
}

async function attachCertificate(
  command: RelayCommand,
  deps: RegionalCertificateExecutorDeps,
): Promise<RelayCommandResult> {
  const parsed = attachCertificatePayloadSchema.safeParse(command.payload);
  if (!parsed.success) {
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      error: `Invalid ATTACH_CERTIFICATE payload: ${parsed.error.message}`,
      failureCode: 'UNKNOWN',
    };
  }
  const payload = parsed.data;

  try {
    const output = await attachCertificateToLoadBalancer(deps, payload.certificateArn);
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output,
    };
  } catch (err) {
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      error: String(err),
      failureCode: isAccessDenied(err) ? 'AWS_PERMISSION_DENIED' : 'UNKNOWN',
    };
  }
}

/** Build the ENSURE_CERTIFICATE / ATTACH_CERTIFICATE executors from injected AWS seams. */
export function createRegionalCertificateExecutors(deps: RegionalCertificateExecutorDeps): {
  ENSURE_CERTIFICATE: CommandExecutor;
  ATTACH_CERTIFICATE: CommandExecutor;
} {
  return {
    ENSURE_CERTIFICATE: (command) => ensureCertificate(command, deps),
    ATTACH_CERTIFICATE: (command) => attachCertificate(command, deps),
  };
}

// ── Real AWS client (lazy SDK singleton) ─────────────────────────────────────
//
// Same construct-on-first-use rule as domain.ts's `getAcmSdkClient()` — this
// module must be importable (transitively, via ./index.ts) without touching
// the AWS SDK or requiring credentials/region.

let acmSdkClient: ACMClient | undefined;

function getAcmSdkClient(): ACMClient {
  if (!acmSdkClient) {
    acmSdkClient = new ACMClient({});
  }
  return acmSdkClient;
}

const realRegionalAcmClient: RegionalAcmClient = {
  async describeCertificate(arn) {
    try {
      const response = await getAcmSdkClient().send(new DescribeCertificateCommand({ CertificateArn: arn }));
      const certificate = response.Certificate;
      const status = (certificate?.Status ?? 'PENDING_VALIDATION') as AcmCertificateStatus;
      const resourceRecord = certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
      return {
        status,
        ...(resourceRecord?.Name && resourceRecord?.Value
          ? {
              validationRecord: {
                name: resourceRecord.Name,
                value: resourceRecord.Value,
                type: resourceRecord.Type ?? 'CNAME',
              },
            }
          : {}),
        ...(certificate?.FailureReason ? { failureReason: certificate.FailureReason } : {}),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async findCertificatesByTag(domain, tagKey, tagValue) {
    const client = getAcmSdkClient();
    const matches: Array<{ arn: string; status: AcmCertificateStatus }> = [];
    let nextToken: string | undefined;
    do {
      const response = await client.send(new ListCertificatesCommand({ NextToken: nextToken }));
      for (const summary of response.CertificateSummaryList ?? []) {
        if (!summary.CertificateArn || summary.DomainName !== domain) continue;
        try {
          const tags = await client.send(
            new ListTagsForCertificateCommand({ CertificateArn: summary.CertificateArn }),
          );
          const owns = (tags.Tags ?? []).some((tag) => tag.Key === tagKey && tag.Value === tagValue);
          if (owns) {
            matches.push({
              arn: summary.CertificateArn,
              status: (summary.Status ?? 'PENDING_VALIDATION') as AcmCertificateStatus,
            });
          }
        } catch (err) {
          // An access-denied while reading another certificate's tags means
          // it is not readable as ours — skip it, never throw (a sibling
          // relay's certificate must stay invisible to this one).
          if (!isAccessDenied(err)) throw err;
        }
      }
      nextToken = response.NextToken;
    } while (nextToken !== undefined);
    return matches;
  },

  async requestCertificate({ domainName, idempotencyToken, tags }) {
    const response = await getAcmSdkClient().send(
      new RequestCertificateCommand({
        DomainName: domainName,
        ValidationMethod: 'DNS',
        IdempotencyToken: idempotencyToken,
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
    if (!response.CertificateArn) {
      throw new Error('ACM RequestCertificate returned no CertificateArn');
    }
    return response.CertificateArn;
  },

  async deleteCertificate(arn) {
    for (let attempt = 1; ; attempt++) {
      try {
        await getAcmSdkClient().send(new DeleteCertificateCommand({ CertificateArn: arn }));
        return;
      } catch (err) {
        if (isNotFound(err)) return;
        if (!isCertificateInUse(err) || attempt >= CERTIFICATE_DELETE_RETRY_ATTEMPTS) throw err;
        await defaultSleep(CERTIFICATE_DELETE_RETRY_DELAY_MS);
      }
    }
  },
};

/** Real AWS-backed RegionalAcmClient, lazily constructed. */
export function createRealRegionalAcmClient(): RegionalAcmClient {
  return realRegionalAcmClient;
}

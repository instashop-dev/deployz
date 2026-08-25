/**
 * Relay domain executors — ACM certificate + ALB listener orchestration for
 * custom domains, run inside the customer's AWS account.
 *
 * Everything that talks to AWS is behind the `AcmClient`/`ElbClient` seams
 * (the house idiom: narrow injectable interface + real SDK impl +
 * in-memory fakes in tests — see `./auth.ts`'s `SecretsClient` for the
 * local example). `createDomainExecutors` contains all the orchestration
 * logic and is exercised in tests purely against fakes; `createRealDomainAwsClients`
 * is the thin, untested-by-design real implementation wired in `./index.ts`.
 */

import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';
import {
  AddListenerCertificatesCommand,
  CreateListenerCommand,
  DeleteListenerCommand,
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
  ModifyListenerCommand,
  RemoveListenerCertificatesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

import type { CommandExecutor, RelayCommand, RelayCommandResult } from './commands.js';

// ── Injectable AWS seams ─────────────────────────────────────────────────────

/** ACM operations the domain executors need (injectable seam for testing). */
export interface AcmClient {
  requestCertificate(p: {
    domainName: string;
    idempotencyToken: string;
    tags: Record<string, string>;
  }): Promise<string>; // arn
  describeCertificate(arn: string): Promise<{
    status: string; // 'PENDING_VALIDATION' | 'ISSUED' | 'FAILED' | …
    validationRecord?: { name: string; value: string };
  }>;
  deleteCertificate(arn: string): Promise<void>; // must swallow ResourceNotFoundException
}

export interface LoadBalancerInfo {
  arn: string;
  dnsName: string;
}

export interface ListenerInfo {
  arn: string;
  port: number;
  defaultCertificateArn?: string;
  redirectsToHttps: boolean;
  forwardTargetGroupArn?: string;
}

/** ALB operations the domain executors need (injectable seam for testing). */
export interface ElbClient {
  findTaggedLoadBalancer(tagKey: string, tagValue: string): Promise<LoadBalancerInfo | undefined>;
  describeListeners(loadBalancerArn: string): Promise<ListenerInfo[]>;
  describeTargetGroups(loadBalancerArn: string): Promise<string[]>; // target group arns
  createHttpsListener(p: { loadBalancerArn: string; certificateArn: string; targetGroupArn: string }): Promise<void>;
  addListenerCertificate(listenerArn: string, certificateArn: string): Promise<void>; // idempotent
  removeListenerCertificate(listenerArn: string, certificateArn: string): Promise<void>; // swallow not-found
  deleteListener(listenerArn: string): Promise<void>;
  setHttpRedirect(listenerArn: string): Promise<void>; // 80 → 301 https://#{host}:443
  setHttpForward(listenerArn: string, targetGroupArn: string): Promise<void>;
}

// ── Command payload shape ────────────────────────────────────────────────────

interface DomainCommandPayload {
  hostname: string;
  domainId: string;
  certificateArn?: string;
}

function readPayload(command: RelayCommand): DomainCommandPayload {
  return command.payload as unknown as DomainCommandPayload;
}

/** Does this AWS error look like an access-denied rejection? */
function isAccessDenied(err: unknown): boolean {
  const name = typeof (err as { name?: unknown } | undefined)?.name === 'string' ? (err as { name: string }).name : '';
  const code =
    typeof (err as { Code?: unknown } | undefined)?.Code === 'string' ? (err as { Code: string }).Code : '';
  return name.includes('AccessDenied') || code.includes('AccessDenied');
}

// ── Executors ─────────────────────────────────────────────────────────────────

interface DomainExecutorDeps {
  acm: AcmClient;
  elb: ElbClient;
  installationId: string;
}

const INSTALLATION_TAG_KEY = 'deployz:installation';

async function configureDomain(command: RelayCommand, deps: DomainExecutorDeps): Promise<RelayCommandResult> {
  const payload = readPayload(command);

  try {
    const certificateArn =
      payload.certificateArn ??
      (await deps.acm.requestCertificate({
        domainName: payload.hostname,
        idempotencyToken: payload.domainId.replace(/-/g, ''),
        tags: { [INSTALLATION_TAG_KEY]: deps.installationId },
      }));

    const certificate = await deps.acm.describeCertificate(certificateArn);
    const loadBalancer = await deps.elb.findTaggedLoadBalancer(INSTALLATION_TAG_KEY, deps.installationId);

    let httpsConfigured = false;

    if (certificate.status === 'ISSUED' && loadBalancer) {
      const listeners = await deps.elb.describeListeners(loadBalancer.arn);
      const httpListener = listeners.find((listener) => listener.port === 80);
      const httpsListener = listeners.find((listener) => listener.port === 443);

      if (!httpsListener) {
        const targetGroupArn =
          httpListener?.forwardTargetGroupArn ?? (await deps.elb.describeTargetGroups(loadBalancer.arn))[0];
        if (targetGroupArn) {
          await deps.elb.createHttpsListener({
            loadBalancerArn: loadBalancer.arn,
            certificateArn,
            targetGroupArn,
          });
          httpsConfigured = true;
        }
      } else {
        if (httpsListener.defaultCertificateArn !== certificateArn) {
          await deps.elb.addListenerCertificate(httpsListener.arn, certificateArn);
        }
        httpsConfigured = true;
      }

      if (httpsConfigured && httpListener && !httpListener.redirectsToHttps) {
        await deps.elb.setHttpRedirect(httpListener.arn);
      }
    }

    const output: Record<string, unknown> = {
      certificateArn,
      certificateStatus: certificate.status,
      ...(certificate.validationRecord
        ? {
            validationName: certificate.validationRecord.name,
            validationValue: certificate.validationRecord.value,
          }
        : {}),
      ...(loadBalancer ? { routingTarget: loadBalancer.dnsName } : {}),
      httpsConfigured,
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

async function removeDomain(command: RelayCommand, deps: DomainExecutorDeps): Promise<RelayCommandResult> {
  const payload = readPayload(command);

  try {
    if (payload.certificateArn) {
      const loadBalancer = await deps.elb.findTaggedLoadBalancer(INSTALLATION_TAG_KEY, deps.installationId);

      if (loadBalancer) {
        const listeners = await deps.elb.describeListeners(loadBalancer.arn);
        const httpsListener = listeners.find((listener) => listener.port === 443);

        if (httpsListener) {
          if (httpsListener.defaultCertificateArn === payload.certificateArn) {
            await deps.elb.deleteListener(httpsListener.arn);

            const httpListener = listeners.find((listener) => listener.port === 80);
            if (httpListener?.redirectsToHttps) {
              const targetGroupArn = (await deps.elb.describeTargetGroups(loadBalancer.arn))[0];
              if (targetGroupArn) {
                await deps.elb.setHttpForward(httpListener.arn, targetGroupArn);
              }
            }
          } else {
            await deps.elb.removeListenerCertificate(httpsListener.arn, payload.certificateArn);
          }
        }
      }

      await deps.acm.deleteCertificate(payload.certificateArn);
    }

    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output: { removed: true },
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

/** Build the CONFIGURE_DOMAIN / REMOVE_DOMAIN executors from injected AWS seams. */
export function createDomainExecutors(deps: DomainExecutorDeps): {
  CONFIGURE_DOMAIN: CommandExecutor;
  REMOVE_DOMAIN: CommandExecutor;
} {
  return {
    CONFIGURE_DOMAIN: (command) => configureDomain(command, deps),
    REMOVE_DOMAIN: (command) => removeDomain(command, deps),
  };
}

// ── Real AWS clients (lazy SDK singletons) ───────────────────────────────────
//
// The SDK client objects are constructed lazily, on first use, rather than at
// module load — so importing this module (transitively, via ./index.ts) never
// touches the AWS SDK. That keeps handler unit tests (index.test.ts) free of
// any AWS credential/region requirement. Region comes from the Lambda's own
// environment/default credential chain — the relay always operates in its
// home region, so no explicit region is passed here.

let acmSdkClient: ACMClient | undefined;
let elbSdkClient: ElasticLoadBalancingV2Client | undefined;

function getAcmSdkClient(): ACMClient {
  if (!acmSdkClient) {
    acmSdkClient = new ACMClient({});
  }
  return acmSdkClient;
}

function getElbSdkClient(): ElasticLoadBalancingV2Client {
  if (!elbSdkClient) {
    elbSdkClient = new ElasticLoadBalancingV2Client({});
  }
  return elbSdkClient;
}

/** Does this AWS error look like a "resource not found" rejection? */
function isNotFound(err: unknown): boolean {
  const name = typeof (err as { name?: unknown } | undefined)?.name === 'string' ? (err as { name: string }).name : '';
  return name.includes('NotFound');
}

const realAcmClient: AcmClient = {
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

  async describeCertificate(arn) {
    const response = await getAcmSdkClient().send(new DescribeCertificateCommand({ CertificateArn: arn }));
    const certificate = response.Certificate;
    const status = certificate?.Status ?? 'PENDING_VALIDATION';
    const resourceRecord = certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
    return {
      status,
      ...(resourceRecord?.Name && resourceRecord?.Value
        ? { validationRecord: { name: resourceRecord.Name, value: resourceRecord.Value } }
        : {}),
    };
  },

  async deleteCertificate(arn) {
    try {
      await getAcmSdkClient().send(new DeleteCertificateCommand({ CertificateArn: arn }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },
};

const realElbClient: ElbClient = {
  async findTaggedLoadBalancer(tagKey, tagValue) {
    const client = getElbSdkClient();

    const loadBalancers: { arn: string; dnsName: string }[] = [];
    let marker: string | undefined;
    do {
      const response = await client.send(new DescribeLoadBalancersCommand({ Marker: marker }));
      for (const lb of response.LoadBalancers ?? []) {
        if (lb.LoadBalancerArn && lb.DNSName) {
          loadBalancers.push({ arn: lb.LoadBalancerArn, dnsName: lb.DNSName });
        }
      }
      marker = response.NextMarker;
    } while (marker);

    for (let i = 0; i < loadBalancers.length; i += 20) {
      const chunk = loadBalancers.slice(i, i + 20);
      const tagsResponse = await client.send(
        new DescribeTagsCommand({ ResourceArns: chunk.map((lb) => lb.arn) }),
      );
      for (const tagDescription of tagsResponse.TagDescriptions ?? []) {
        const matches = tagDescription.Tags?.some((tag) => tag.Key === tagKey && tag.Value === tagValue);
        if (matches && tagDescription.ResourceArn) {
          const match = chunk.find((lb) => lb.arn === tagDescription.ResourceArn);
          if (match) return match;
        }
      }
    }

    return undefined;
  },

  async describeListeners(loadBalancerArn) {
    const response = await getElbSdkClient().send(
      new DescribeListenersCommand({ LoadBalancerArn: loadBalancerArn }),
    );
    return (response.Listeners ?? []).map((listener) => {
      const defaultAction = listener.DefaultActions?.[0];
      const redirectsToHttps =
        defaultAction?.Type === 'redirect' && defaultAction.RedirectConfig?.Protocol === 'HTTPS';
      const forwardTargetGroupArn = defaultAction?.Type === 'forward' ? defaultAction.TargetGroupArn : undefined;
      // DescribeListeners' Certificates field carries only the listener's
      // default certificate (SNI certs require DescribeListenerCertificates,
      // which the relay never needs), so the first entry is the default.
      const defaultCertificateArn = listener.Certificates?.[0]?.CertificateArn;
      return {
        arn: listener.ListenerArn ?? '',
        port: listener.Port ?? 0,
        redirectsToHttps: Boolean(redirectsToHttps),
        ...(defaultCertificateArn ? { defaultCertificateArn } : {}),
        ...(forwardTargetGroupArn ? { forwardTargetGroupArn } : {}),
      };
    });
  },

  async describeTargetGroups(loadBalancerArn) {
    const response = await getElbSdkClient().send(
      new DescribeTargetGroupsCommand({ LoadBalancerArn: loadBalancerArn }),
    );
    return (response.TargetGroups ?? [])
      .map((tg) => tg.TargetGroupArn)
      .filter((arn): arn is string => Boolean(arn));
  },

  async createHttpsListener({ loadBalancerArn, certificateArn, targetGroupArn }) {
    await getElbSdkClient().send(
      new CreateListenerCommand({
        LoadBalancerArn: loadBalancerArn,
        Protocol: 'HTTPS',
        Port: 443,
        Certificates: [{ CertificateArn: certificateArn }],
        DefaultActions: [{ Type: 'forward', TargetGroupArn: targetGroupArn }],
      }),
    );
  },

  async addListenerCertificate(listenerArn, certificateArn) {
    await getElbSdkClient().send(
      new AddListenerCertificatesCommand({
        ListenerArn: listenerArn,
        Certificates: [{ CertificateArn: certificateArn }],
      }),
    );
  },

  async removeListenerCertificate(listenerArn, certificateArn) {
    try {
      await getElbSdkClient().send(
        new RemoveListenerCertificatesCommand({
          ListenerArn: listenerArn,
          Certificates: [{ CertificateArn: certificateArn }],
        }),
      );
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  async deleteListener(listenerArn) {
    await getElbSdkClient().send(new DeleteListenerCommand({ ListenerArn: listenerArn }));
  },

  async setHttpRedirect(listenerArn) {
    await getElbSdkClient().send(
      new ModifyListenerCommand({
        ListenerArn: listenerArn,
        DefaultActions: [
          {
            Type: 'redirect',
            RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' },
          },
        ],
      }),
    );
  },

  async setHttpForward(listenerArn, targetGroupArn) {
    await getElbSdkClient().send(
      new ModifyListenerCommand({
        ListenerArn: listenerArn,
        DefaultActions: [{ Type: 'forward', TargetGroupArn: targetGroupArn }],
      }),
    );
  },
};

/** Real AWS-backed AcmClient/ElbClient, lazily constructed. */
export function createRealDomainAwsClients(): { acm: AcmClient; elb: ElbClient } {
  return { acm: realAcmClient, elb: realElbClient };
}

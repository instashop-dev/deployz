// §12/§44 public customer installation data — server-side fetch for the
// unauthenticated /install/:installLinkId page. Wired to the real
// (public, no-auth) `GET /api/install/:installLinkId` endpoint.
//
// The route parameter is the install-LINK id, which is not the relay's
// installation id. They used to be the same value, which made the link a
// customer is emailed also the identifier a relay authenticates against.

import { serverApiUrl } from '@/lib/api-url';
import type { CustomDomainView } from '@/lib/domains';

interface InstallData {
  applicationName: string;
  publisherName: string;
  customerName: string;
  region: string;
  /** §44 "Deployz will create" list, e.g. ["Application runtime", "PostgreSQL database", ...]. */
  resourcesCreated: string[];
  /**
   * CloudFormation Quick Create deep-link for THIS deployment, built by the
   * control plane: it owns the published template URL, the deployment's
   * region and the single-use enrollment code. Null when no bootstrap
   * template is published yet.
   */
  quickCreateUrl: string | null;
  /** True once a relay has enrolled — the link has already been used. */
  alreadyInstalled: boolean;
  /** The deployment this install link names — needed once installed, to scope the domain card. */
  deploymentId: string;
  deploymentState: string;
  /** This deployment's active custom domain, if any. */
  domain: CustomDomainView | null;
  /** The CNAME target a customer without a custom domain yet would point at. */
  routingTarget: string | null;
  /** The expected bootstrap stack name for the current attempt. */
  bootstrapStackName: string;
  /** The customer launched the install and Deployz is waiting for the relay. */
  waitingForRelay: boolean;
  /** waitingForRelay past the relay-staleness window — guidance, never a failure. */
  relayStuck: boolean;
  /** §24 component view, same derivation the fleet row uses. Null until enrolled. */
  components: Record<string, string> | null;
}

/** Fetch the public install page data. Returns null on a 404 (unknown/invalid link). */
export async function fetchInstallData(installLinkId: string): Promise<InstallData | null> {
  const response = await fetch(`${serverApiUrl()}/api/install/${encodeURIComponent(installLinkId)}`, {
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Install request failed (${response.status})`);
  }
  return (await response.json()) as InstallData;
}

// ── Pre-relay install lifecycle (public, no-auth — keyed on the link) ──────

/**
 * Fire-and-forget launch signal: the install page reports the customer
 * pressing "Deploy to AWS" so the deployment can show an explicit waiting
 * state. Best-effort — a failure must never block the handoff to AWS.
 */
export async function launchInstall(installLinkId: string): Promise<void> {
  try {
    await fetch(`${serverApiUrl()}/api/install/${encodeURIComponent(installLinkId)}/launched`, {
      method: 'POST',
      cache: 'no-store',
    });
  } catch {
    // The customer still goes to AWS; the signal is not worth blocking on.
  }
}

/** The fresh-attempt response from POST /api/install/:id/retry. */
export interface RetryInstallResult {
  state: 'NOT_INSTALLED';
  attemptNumber: number;
  bootstrapStackName: string;
  quickCreateUrl: string | null;
}

/** A failed retry that knows WHICH status and error code came back. */
export class InstallRetryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Install retry failed (${status})`);
    this.name = 'InstallRetryError';
  }
}

/**
 * Customer-facing retry for an install that never connected: fresh attempt
 * (new enrollment code, attempt+1, new stack name). 409
 * INSTALL_ALREADY_SUCCEEDED when the deployment was ever installed
 * successfully.
 */
export async function retryInstallAttempt(installLinkId: string): Promise<RetryInstallResult> {
  const response = await fetch(`${serverApiUrl()}/api/install/${encodeURIComponent(installLinkId)}/retry`, {
    method: 'POST',
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const envelope = payload as { error?: { code?: string } } | null;
    throw new InstallRetryError(response.status, envelope?.error?.code ?? 'REQUEST_FAILED');
  }
  return (await response.json()) as RetryInstallResult;
}

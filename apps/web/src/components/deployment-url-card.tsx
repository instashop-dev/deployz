'use client';

import { AlertCircle, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DOMAIN_STATUS_LABEL } from '@/lib/domains';
import type { FleetDeploymentDetail } from '@/lib/deployments';

/** The permanent Deployz address for a deployment.
 *
 * NOTE: this is a client-side projection. The API does not yet expose a
 * dedicated `defaultUrl` field; the control plane will wire the real
 * default-HTTPS hostname in a later phase. Until then, the UI mints the
 * canonical `d-<id>.deployz.dev` hostname locally. */
export function defaultDeployzUrl(deploymentId: string): string {
  return `https://d-${deploymentId}.deployz.dev`;
}

/** The customer-facing status label for a custom domain in the URL card. */
const CUSTOM_DOMAIN_STATUS_LABEL: Record<string, string> = {
  ...DOMAIN_STATUS_LABEL,
  pending: 'Waiting for domain setup',
  waiting_for_dns: 'Waiting for domain setup',
  configuring: 'Connecting',
  removing: 'Removing domain…',
};

interface DeploymentUrlCardProps {
  detail: FleetDeploymentDetail;
}

/**
 * The access section of the deployment-detail hero. Always shows the
 * application URL; when a custom domain is configured, it also shows the
 * permanent Deployz address and the custom domain's status.
 */
export function DeploymentUrlCard({ detail }: DeploymentUrlCardProps) {
  const custom = detail.customDomain;
  const defaultUrl = defaultDeployzUrl(detail.id);
  const appUrl = detail.appUrl ?? defaultUrl;
  const customActive = custom?.status === 'active';

  const primaryUrl = customActive ? `https://${custom.hostname}` : appUrl;
  const primaryLabel = customActive ? 'Application URL' : custom ? 'Deployz address' : 'Application URL';
  const primarySecure = primaryUrl.startsWith('https://');
  const healthy = detail.healthStatus === 'HEALTHY';

  return (
    <div className="flex flex-col gap-3">
      <UrlBlock
        label={primaryLabel}
        url={primaryUrl}
        healthy={healthy}
        secure={primarySecure}
        active={!customActive && custom !== null}
      />

      {customActive ? (
        <UrlBlock label="Deployz address" url={defaultUrl} secure healthy={false} active />
      ) : null}

      <CustomDomainSection detail={detail} />
    </div>
  );
}

function UrlBlock({
  label,
  url,
  healthy,
  secure,
  active,
}: {
  label: string;
  url: string;
  healthy: boolean;
  secure: boolean;
  active: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context); the link
      // itself still lets the user open or select the URL by hand.
    }
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-lg bg-muted/50 px-3 py-2.5 sm:flex-row sm:items-center"
      data-testid="app-url"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 max-w-full items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <span className="truncate">{url}</span>
          <ExternalLink aria-hidden className="size-3.5 shrink-0" />
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {active ? <Badge variant="secondary">Active</Badge> : null}
        {healthy ? <Badge variant="secondary">Healthy</Badge> : null}
        {secure ? <Badge variant="secondary">Secure</Badge> : null}
        <Button asChild size="sm">
          <a href={url} target="_blank" rel="noreferrer">
            Open application
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function CustomDomainSection({ detail }: { detail: FleetDeploymentDetail }) {
  const custom = detail.customDomain;
  const defaultUrl = defaultDeployzUrl(detail.id);

  if (!custom) {
    return (
      <div className="rounded-lg border px-3 py-2.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Custom domain</p>
            <p className="text-sm text-muted-foreground">Not configured</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/install/${detail.installLinkId}`}>Add custom domain</Link>
          </Button>
        </div>
      </div>
    );
  }

  const url = `https://${custom.hostname}`;
  const statusLabel = CUSTOM_DOMAIN_STATUS_LABEL[custom.status] ?? DOMAIN_STATUS_LABEL[custom.status];

  if (custom.status === 'error') {
    return (
      <div
        className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5"
        data-testid="custom-domain-error"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-destructive">Custom domain needs attention</p>
              <p className="text-sm text-muted-foreground">
                Your application remains available at:{" "}
                <a
                  href={defaultUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {defaultUrl}
                </a>
              </p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline" className="self-start">
            <Link href={`/install/${detail.installLinkId}`}>Manage custom domain</Link>
          </Button>
        </div>
      </div>
    );
  }

  const pending = custom.status === 'pending' || custom.status === 'waiting_for_dns' || custom.status === 'configuring';

  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">Custom domain</p>
          <div className="flex flex-wrap items-center gap-2">
            {custom.status === 'active' ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {url}
              </a>
            ) : (
              <span className="text-sm font-medium text-foreground">{url}</span>
            )}
            <Badge variant={custom.status === 'active' ? 'secondary' : 'outline'}>
              {statusLabel}
            </Badge>
          </div>
          {pending ? (
            <p className="mt-1 text-xs text-muted-foreground">Waiting for domain setup</p>
          ) : null}
        </div>
        <Button asChild size="sm" variant="outline" className="self-start sm:self-auto">
          <Link href={`/install/${detail.installLinkId}`}>
            {custom.status === 'active' ? 'Manage custom domain' : 'Check custom domain'}
          </Link>
        </Button>
      </div>
    </div>
  );
}

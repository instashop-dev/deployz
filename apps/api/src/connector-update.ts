import { BOOTSTRAP_TEMPLATE_KEY, resolveBootstrapTemplate } from '@deployz/contracts';

/**
 * What the customer needs to update the connector (bootstrap) stack that
 * already exists in their AWS account. An update keeps the stack's
 * installation id, relay credential, markers and application stack; only the
 * template changes. Distinct from a relay reset, which issues a new credential.
 */
export interface ConnectorUpdateOffer {
  /** Build id of the connector Deployz currently publishes; null when the control plane does not know it. */
  publishedBuildId: string | null;
  /** Console page of the existing connector stack, where the customer chooses Update. */
  updateUrl: string | null;
  /** Template URL to paste at "Replace existing template" — the immutable versioned copy when the build id is known. */
  templateUrl: string | null;
}

export interface ConnectorUpdateConfig {
  buildId: string | undefined;
  legacyUrl: string | undefined;
  deployableRegions: readonly string[];
}

export function connectorUpdateOffer(
  deployment: { region: string; state: string; relayBoundAt: Date | null; bootstrapStackName: string | null },
  config: ConnectorUpdateConfig,
): ConnectorUpdateOffer | null {
  if (deployment.relayBoundAt === null || deployment.state === 'DELETING' || deployment.state === 'DELETED') {
    return null;
  }
  const latest = resolveBootstrapTemplate(deployment.region, {
    ...(config.legacyUrl ? { legacyUrl: config.legacyUrl } : {}),
    deployableRegions: config.deployableRegions,
  });
  const templateUrl =
    latest && config.buildId
      ? latest.replace(
          new RegExp(`/${BOOTSTRAP_TEMPLATE_KEY}$`),
          `/versions/${config.buildId}/${BOOTSTRAP_TEMPLATE_KEY}`,
        )
      : (latest ?? null);
  const filter = deployment.bootstrapStackName
    ? `&filteringText=${encodeURIComponent(deployment.bootstrapStackName)}`
    : '';
  return {
    publishedBuildId: config.buildId ?? null,
    updateUrl: `https://${deployment.region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(deployment.region)}#/stacks?filteringStatus=active${filter}`,
    templateUrl,
  };
}

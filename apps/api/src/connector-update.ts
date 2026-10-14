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

/** Console page of an existing connector stack and the template to choose when updating it. */
export function connectorUpdateLinks(
  region: string,
  stackName: string | null,
  config: ConnectorUpdateConfig,
): { updateUrl: string; templateUrl: string | null } {
  const latest = resolveBootstrapTemplate(region, {
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
  const filter = stackName ? `&filteringText=${encodeURIComponent(stackName)}` : '';
  return {
    updateUrl: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}#/stacks?filteringStatus=active${filter}`,
    templateUrl,
  };
}

export function connectorUpdateOffer(
  deployment: { region: string; state: string; relayBoundAt: Date | null; bootstrapStackName: string | null },
  config: ConnectorUpdateConfig,
): ConnectorUpdateOffer | null {
  if (deployment.relayBoundAt === null || deployment.state === 'DELETING' || deployment.state === 'DELETED') {
    return null;
  }
  return {
    publishedBuildId: config.buildId ?? null,
    ...connectorUpdateLinks(deployment.region, deployment.bootstrapStackName, config),
  };
}

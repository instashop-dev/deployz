// Standardized AWS resource tags for Deployz-managed infrastructure.
//
// The application templates are pre-synthesized at publish time, so every
// per-deployment tag value travels as a stack-level `Tags` entry on the
// relay's CreateStack call — CloudFormation propagates stack-level tags to
// every taggable resource, including the retained RDS instance and S3 bucket.
// The one home for the shared constants and the record builder keeps the
// control plane (which mints them) and the relay (which applies them) from
// drifting apart.

/** Links an AWS resource to the Deployz installation that owns it. */
export const DEPLOYZ_INSTALLATION_TAG = 'deployz:installation';

/** Names the major infrastructure component a resource belongs to. */
export const DEPLOYZ_COMPONENT_TAG = 'deployz:component';

/**
 * The only environment value the MVP emits. No environment concept exists
 * yet, so every deployment is production — a constant, not a parameter.
 */
export const DEPLOYZ_ENVIRONMENT_TAG_VALUE = 'production';

/**
 * The common identity tags for one deployment's AWS resources, as minted by
 * the control plane and applied as stack-level CloudFormation tags.
 *
 * Values are STABLE INTERNAL IDS ONLY — never names, emails, secrets, or
 * any other PII. Tags are descriptive metadata: the database and
 * CloudFormation stay the source of truth for ownership and deployment
 * state, and no tag ever drives a lifecycle decision. `releaseId` is
 * omitted when no release was selected for the install.
 */
export function buildDeploymentResourceTags(identity: {
  deploymentId: string;
  applicationId: string;
  customerId: string;
  vendorId: string;
  releaseId?: string;
}): Record<string, string> {
  return {
    'deployz:managed-by': 'deployz',
    'deployz:deployment-id': identity.deploymentId,
    'deployz:application-id': identity.applicationId,
    'deployz:customer-id': identity.customerId,
    'deployz:vendor-id': identity.vendorId,
    ...(identity.releaseId !== undefined ? { 'deployz:release-id': identity.releaseId } : {}),
    'deployz:environment': DEPLOYZ_ENVIRONMENT_TAG_VALUE,
  };
}

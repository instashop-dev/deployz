/**
 * Server-side CloudFormation Quick Create URL construction for the public
 * install page.
 *
 * MIRROR of `packages/cdk/src/quick-create/install-link.ts`
 * (`buildBootstrapQuickCreateUrl`) — the @deployz/cdk package is not a
 * dependency of this app (it would pull aws-cdk-lib into the web bundle), so
 * the equivalent pure URL construction lives here. The format is locked by
 * `packages/cdk/test/quick-create.test.ts` and by `apps/web/test/install-link.test.ts`;
 * any change must stay in parity with the CDK source of truth.
 *
 * The URL carries NO credential and NO secret: only the non-secret
 * `ControlPlaneUrl` template parameter. The bootstrap-generated credential
 * and the minted installation identifier are deploy-time values produced
 * inside the customer account (todo 8) and never appear in a URL.
 */

/** Default CloudFormation stack name for the customer bootstrap stack. */
export const DEFAULT_BOOTSTRAP_STACK_NAME = 'deployz-bootstrap';

/** The bootstrap stack's single (non-secret) template parameter. */
export const CONTROL_PLANE_URL_PARAMETER = 'ControlPlaneUrl';

/** The bootstrap stack's single-use enrollment parameter. */
export const ENROLLMENT_CODE_PARAMETER = 'EnrollmentCode';

/**
 * Fixture defaults so the public install pages render with zero backend and
 * zero configuration. Production overrides come from the environment.
 */
export const FIXTURE_TEMPLATE_URL =
  'https://fixtures.deployz.dev/templates/bootstrap-template-v1.json';
export const DEFAULT_CONTROL_PLANE_URL = 'https://api.deployz.dev';
export const DEFAULT_REGION = 'us-east-1';

export interface InstallLinkConfig {
  /** AWS region the console deep-link targets. */
  readonly region: string;
  /** Public HTTPS URL of the published bootstrap template. */
  readonly templateUrl: string;
  /** Base URL of the Deployz control plane the relay polls (non-secret). */
  readonly controlPlaneUrl: string;
  /** CloudFormation stack name. */
  readonly stackName: string;
}

/**
 * Resolves the install-link configuration from the environment, falling back
 * to deterministic fixture values. Reading env at request time (the page is
 * `force-dynamic`) lets the todo-14 integration harness point the CTA at the
 * real published template without a rebuild.
 */
export function getInstallLinkConfig(): InstallLinkConfig {
  return {
    region: process.env.DEPLOYZ_BOOTSTRAP_REGION ?? DEFAULT_REGION,
    templateUrl: process.env.DEPLOYZ_BOOTSTRAP_TEMPLATE_URL ?? FIXTURE_TEMPLATE_URL,
    controlPlaneUrl: process.env.DEPLOYZ_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL,
    stackName: process.env.DEPLOYZ_BOOTSTRAP_STACK_NAME ?? DEFAULT_BOOTSTRAP_STACK_NAME,
  };
}

/**
 * Builds the deterministic CloudFormation Quick Create deep-link:
 *
 *   https://{region}.console.aws.amazon.com/cloudformation/home?region={region}
 *     #/stacks/create/review
 *     ?templateURL={url-encoded templateUrl}
 *     &stackName={stackName}
 *     &param_ControlPlaneUrl={controlPlaneUrl}
 *     &param_EnrollmentCode={enrollmentCode}
 *
 * Pure — same inputs, same URL. `URLSearchParams` keeps the parameter order
 * deterministic (templateURL, stackName, then params).
 */
export function buildBootstrapQuickCreateUrl(
  config: InstallLinkConfig,
  enrollmentCode: string,
): string {
  const base =
    `https://${config.region}.console.aws.amazon.com/cloudformation/home` +
    `?region=${encodeURIComponent(config.region)}` +
    `#/stacks/create/review`;

  const query = new URLSearchParams();
  query.set('templateURL', config.templateUrl);
  query.set('stackName', config.stackName);
  query.set(`param_${CONTROL_PLANE_URL_PARAMETER}`, config.controlPlaneUrl);
  query.set(`param_${ENROLLMENT_CODE_PARAMETER}`, enrollmentCode);

  return `${base}?${query.toString()}`;
}

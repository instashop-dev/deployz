/**
 * CloudFormation Quick Create install-link generator.
 *
 * This is the CENTERPIECE of the vendor → customer handoff: a deterministic,
 * one-click URL that drops the customer onto the CloudFormation console
 * "Quick create stack" page with the bootstrap template and its parameters
 * pre-populated.
 *
 * The URL is PURE string construction — no AWS calls, no credentials, no
 * secrets. The only parameter carried is the non-secret `ControlPlaneUrl`
 * (a public URL). The bootstrap-generated communication credential and the
 * minted installation identifier are NEVER in the URL: they are produced at
 * deploy time inside the customer account (todo 8).
 *
 * URL format (AWS CloudFormation Console — "Use quick-create links to create
 * CloudFormation stacks"):
 *
 *   https://{region}.console.aws.amazon.com/cloudformation/home?region={region}
 *     #/stacks/create/review
 *     ?templateURL={templateUrl}
 *     &stackName={stackName}
 *     &param_{parameterName}={parameterValue}
 *
 * Notes (verified against the AWS docs):
 *   - `templateURL` MUST point at a template stored in a PUBLIC S3 bucket and
 *     should be URL-encoded (mandatory for presigned URLs, safe always).
 *   - `param_` is the console's prefix for URL-suppliable template parameters.
 *   - CloudFormation IGNORES parameters whose `NoEcho` is `true` in the URL
 *     (by design — secrets are never passed through a link). The bootstrap
 *     stack's single parameter (`ControlPlaneUrl`) is non-NoEcho, so it is
 *     URL-suppliable; the application stack's `param_AppApiKey` /
 *     `param_AppSigningSecret` (NoEcho, todo 9 / M17) are never URL-supplied —
 *     the control plane passes them via the CreateStack API through the relay.
 */

/** Default CloudFormation stack name for the customer bootstrap stack. */
export const DEFAULT_BOOTSTRAP_STACK_NAME = 'deployz-bootstrap';

/** The bootstrap stack's single (non-secret) template parameter. */
export const CONTROL_PLANE_URL_PARAMETER = 'ControlPlaneUrl';

export interface QuickCreateUrlOptions {
  /** AWS region the console deep-link targets (e.g. `us-east-1`). */
  readonly region: string;
  /** Public HTTPS URL of the published CloudFormation template (in S3). */
  readonly templateUrl: string;
  /** CloudFormation stack name. Defaults to `deployz-bootstrap`. */
  readonly stackName?: string;
  /**
   * Template parameters keyed by parameter name (the console `param_` prefix
   * is added automatically). Only NON-NoEcho parameters may be supplied here.
   */
  readonly parameters?: Record<string, string>;
}

/**
 * Builds a deterministic CloudFormation Quick Create deep-link.
 *
 * Pure — the same inputs always produce the same URL, and the output carries
 * no credential or secret (callers are responsible for never passing a
 * NoEcho/secret parameter value in `parameters`).
 */
export function buildQuickCreateUrl(options: QuickCreateUrlOptions): string {
  const { region, templateUrl } = options;
  const stackName = options.stackName ?? DEFAULT_BOOTSTRAP_STACK_NAME;

  const base =
    `https://${region}.console.aws.amazon.com/cloudformation/home` +
    `?region=${encodeURIComponent(region)}` +
    `#/stacks/create/review`;

  const query = new URLSearchParams();
  query.set('templateURL', templateUrl);
  query.set('stackName', stackName);
  for (const [name, value] of Object.entries(options.parameters ?? {})) {
    query.set(`param_${name}`, value);
  }

  return `${base}?${query.toString()}`;
}

export interface BootstrapQuickCreateUrlOptions {
  readonly region: string;
  readonly templateUrl: string;
  /** Base URL of the Deployz control plane the relay polls (non-secret). */
  readonly controlPlaneUrl: string;
  readonly stackName?: string;
}

/**
 * Builds the bootstrap Quick Create URL: template URL + stack name + the
 * single non-secret `ControlPlaneUrl` parameter. The credential and install ID
 * are never present.
 */
export function buildBootstrapQuickCreateUrl(
  options: BootstrapQuickCreateUrlOptions,
): string {
  return buildQuickCreateUrl({
    region: options.region,
    templateUrl: options.templateUrl,
    ...(options.stackName !== undefined ? { stackName: options.stackName } : {}),
    parameters: { [CONTROL_PLANE_URL_PARAMETER]: options.controlPlaneUrl },
  });
}

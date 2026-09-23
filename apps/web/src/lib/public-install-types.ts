import type { DeploymentPlan } from '@deployz/contracts';

/** One input the confirm body may (optional) or must (required) supply. */
export interface PublicInstallInput {
  readonly key: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly classification?: string;
  readonly purpose?: string;
  /** Customer-facing label, written by the vendor, shown instead of the raw key. */
  readonly label?: string;
  /** Customer-facing help text, written by the vendor, shown under the label. */
  readonly help?: string;
}

/** One deployable region offered by the publisher. */
export interface PublicInstallRegion {
  readonly value: string;
  readonly label: string;
}

/** GET /api/public-install/:linkId response body. */
export interface PublicInstallResolve {
  application: { name: string };
  publisher: { name: string };
  release: { version: string; createdAt: string };
  regions: PublicInstallRegion[];
  requiredInputs: PublicInstallInput[];
  plan: DeploymentPlan;
}

/** Customer-facing message for a public-install error code. */
export function publicInstallErrorMessage(code: string): string {
  switch (code) {
    case 'PUBLIC_INSTALL_LINK_REVOKED':
      return 'This installation link has been revoked. Contact the publisher for a new link.';
    case 'PUBLIC_INSTALL_LINK_DISABLED':
      return 'This application is not currently available for installation. Contact the publisher.';
    case 'RELEASE_NOT_PUBLISHED':
      return 'This application has no published release yet. Contact the publisher.';
    case 'REGION_NOT_SUPPORTED':
      return 'That region is not available for this application. Select a different region.';
    case 'MANIFEST_NEEDS_CONFIGURATION':
    case 'MANIFEST_NOT_COMPATIBLE':
      return 'This application cannot be installed in its current state. Contact the publisher.';
    case 'PUBLIC_INSTALL_CONFIG_INVALID':
      return 'Some configuration values are missing or not valid. Check the fields and try again.';
    case 'SUBSCRIPTION_REQUIRED':
      return 'The publisher must fix their Deployz subscription before this application can be installed. Contact the publisher.';
    case 'VALIDATION_ERROR':
      return 'The submitted information is not valid. Check the fields and try again.';
    default:
      return 'Installation could not start. Try again or contact the publisher.';
  }
}

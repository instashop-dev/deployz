/**
 * Custom Resource handler — mint the per-installation identifier.
 *
 * CloudFormation invokes this Lambda (through the custom-resources Provider
 * framework) during the customer's one-click bootstrap deploy. On Create it
 * mints a fresh UUIDv4 installation identifier and returns it as BOTH the
 * physical resource id and the `InstallationId` attribute (`Fn::GetAtt`),
 * which the stack uses to tag every resource and wire the relay environment.
 *
 * The identifier is stable for the life of the installation: Update/Delete
 * reuse the physical resource id so a stack update never re-mints it (which
 * would break the tag boundary and the install-ID ↔ token binding).
 *
 * It is NOT a secret and NOT a CloudFormation template parameter — it is
 * minted at deploy time and never appears in the template or the Quick Create
 * URL. The communication credential is generated separately by CloudFormation
 * (`AWS::SecretsManager::Secret` + `GenerateSecretString`), so neither the
 * identifier nor the credential is ever a template input.
 */
import { randomUUID } from 'node:crypto';

interface BootstrapInitRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly LogicalResourceId: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly ResourceProperties?: Record<string, unknown>;
  readonly OldResourceProperties?: Record<string, unknown>;
}

interface BootstrapInitResponse {
  readonly PhysicalResourceId: string;
  readonly Data: { InstallationId: string };
}

export async function handler(
  event: BootstrapInitRequest,
): Promise<BootstrapInitResponse> {
  // On Create, mint a fresh identifier. On Update/Delete, reuse the physical
  // id so the installation identity never changes under a live stack.
  const installationId =
    event.RequestType === 'Create'
      ? randomUUID()
      : (event.PhysicalResourceId ?? randomUUID());

  return {
    PhysicalResourceId: installationId,
    Data: { InstallationId: installationId },
  };
}

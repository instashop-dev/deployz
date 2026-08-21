/**
 * Template repack — makes a CDK-synthesized CloudFormation template deployable
 * STANDALONE (via a Quick Create URL), without the CDK bootstrap bucket.
 *
 * A raw `cdk synth` output is NOT directly deployable by a fresh customer
 * account because:
 *
 *   1. Every `AWS::Lambda::Function` `Code` points at the CDK asset bucket
 *      `cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}` (via `Fn::Sub`),
 *      which does not exist unless the customer ran `cdk bootstrap`.
 *   2. A synthetic `BootstrapVersion` parameter reads an SSM parameter
 *      (`/cdk-bootstrap/hnb659fds/version`) that a fresh account does not have.
 *   3. A `Rules.CheckBootstrapVersion` assertion references that parameter and
 *      would fail stack creation on a non-bootstrapped account.
 *
 * `repackTemplate` rewrites (1) to point at the PUBLIC S3 bucket the publisher
 * uploads the Lambda assets to, and strips (2)+(3). The result is a
 * self-contained template the customer's CloudFormation can resolve with zero
 * pre-existing resources.
 *
 * Pure — no AWS, no I/O. Fully unit-testable.
 */

type JsonObject = Record<string, unknown>;

interface ResourceShape {
  readonly Type?: unknown;
  readonly Properties?: JsonObject;
}

interface LambdaCodeShape {
  S3Bucket?: unknown;
  S3Key?: unknown;
}

interface TemplateShape extends JsonObject {
  Parameters?: JsonObject;
  Resources?: Record<string, ResourceShape>;
  Rules?: JsonObject;
}

export interface RepackOptions {
  /** Public S3 bucket the Lambda assets are (or will be) uploaded to. */
  readonly bucket: string;
  /** Key prefix under the bucket (e.g. `deployz/bootstrap/v1`). */
  readonly keyPrefix: string;
}

export interface RepackResult {
  /** The self-contained template (a deep copy — the input is never mutated). */
  readonly template: JsonObject;
  /** Source hashes of the Lambda assets whose `Code` was rewritten. */
  readonly assetHashes: string[];
}

/**
 * Rewrites Lambda `Code` references to a public bucket and strips the CDK
 * bootstrap scaffolding (BootstrapVersion parameter + CheckBootstrapVersion
 * rule). Returns a deep copy; the input is untouched.
 */
export function repackTemplate(
  template: JsonObject,
  options: RepackOptions,
): RepackResult {
  // Deep-copy so the caller's template is never mutated.
  const result = structuredClone(template) as TemplateShape;

  const assetHashes: string[] = [];
  const resources = result.Resources ?? {};

  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const code = resource.Properties?.['Code'] as LambdaCodeShape | undefined;
    if (!code) continue;
    // Our synthesized templates emit a plain `<hash>.zip` string key (asset
    // hashes), never an intrinsic. Handle only that shape; anything else is
    // left untouched rather than guessed at.
    const key = code.S3Key;
    if (typeof key !== 'string' || !key.endsWith('.zip')) continue;
    const hash = key.slice(0, -'.zip'.length);

    assetHashes.push(hash);
    code.S3Bucket = options.bucket;
    code.S3Key = `${options.keyPrefix}/${hash}.zip`;
  }

  // Strip the CDK bootstrap scaffolding.
  if (result.Parameters && 'BootstrapVersion' in result.Parameters) {
    delete result.Parameters['BootstrapVersion'];
    if (Object.keys(result.Parameters).length === 0) {
      delete result.Parameters;
    }
  }

  if (result.Rules && 'CheckBootstrapVersion' in result.Rules) {
    delete result.Rules['CheckBootstrapVersion'];
    if (Object.keys(result.Rules).length === 0) {
      delete result.Rules;
    }
  }

  return { template: result, assetHashes };
}

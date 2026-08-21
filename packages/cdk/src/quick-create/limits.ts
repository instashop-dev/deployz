/**
 * CloudFormation template-size and parameter-count limits.
 *
 * CloudFormation caps a template body at 460,800 bytes (450 KB) and 60
 * parameters. These are hard service limits, not guidance: a template over
 * either limit is rejected at `create-stack` time. The Quick Create mechanic
 * publishes templates the CUSTOMER deploys, so we must prove the synthesized
 * templates stay under the limits before handing out a link.
 *
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html
 */

/** Maximum template body size, in bytes (450 KB). */
export const CFN_TEMPLATE_MAX_BYTES = 460_800;

/** Maximum number of template parameters. */
export const CFN_TEMPLATE_MAX_PARAMS = 60;

export interface TemplateLimitsReport {
  /** Byte size of the template JSON (uncompressed). */
  readonly bytes: number;
  /** Number of parameters in the template. */
  readonly parameterCount: number;
  readonly withinByteLimit: boolean;
  readonly withinParamLimit: boolean;
  /** True only when BOTH limits are satisfied. */
  readonly withinLimits: boolean;
}

/** Counts the top-level `Parameters` block of a template object. */
export function countParameters(template: unknown): number {
  const params = (template as { Parameters?: Record<string, unknown> } | null)
    ?.Parameters;
  return Object.keys(params ?? {}).length;
}

/**
 * Asserts a template JSON (string or parsed object) is within the CFN limits.
 *
 * The byte size is measured on the compact `JSON.stringify` representation,
 * matching what CloudFormation receives on the wire. This is a REAL assertion
 * against the synthesized templates — no AWS required.
 */
export function assertTemplateLimits(template: unknown): TemplateLimitsReport {
  const json = typeof template === 'string' ? template : JSON.stringify(template);
  const bytes = Buffer.byteLength(json, 'utf8');
  const parameterCount = countParameters(template);
  const withinByteLimit = bytes <= CFN_TEMPLATE_MAX_BYTES;
  const withinParamLimit = parameterCount <= CFN_TEMPLATE_MAX_PARAMS;

  return {
    bytes,
    parameterCount,
    withinByteLimit,
    withinParamLimit,
    withinLimits: withinByteLimit && withinParamLimit,
  };
}

/**
 * Throws if `template` exceeds either CFN limit. Used by the publisher as a
 * fail-fast guard so an over-limit template is never handed to a customer.
 */
export function requireWithinLimits(template: unknown): TemplateLimitsReport {
  const report = assertTemplateLimits(template);
  if (!report.withinLimits) {
    throw new Error(
      `template exceeds CloudFormation limits: ` +
        `${report.bytes} bytes (max ${CFN_TEMPLATE_MAX_BYTES}), ` +
        `${report.parameterCount} params (max ${CFN_TEMPLATE_MAX_PARAMS})`,
    );
  }
  return report;
}

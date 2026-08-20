/**
 * Bootstrap template publisher — synthesizes the bootstrap stack, repacks the
 * template to be self-contained, and uploads the template + bundled Lambda
 * assets to a PUBLIC S3 location the customer's CloudFormation can resolve.
 *
 * The S3 upload is the ONLY AWS-dependent step; everything else (synth, repack,
 * URL construction, limits) is local and fully testable. The upload is
 * performed through an injectable `S3Client` interface so tests exercise the
 * full publish flow with a mock and no AWS credentials.
 *
 *   synthesizeBootstrapStack() ─▶ template + bundled assets (on disk)
 *        │
 *        ▼
 *   BootstrapPublisher.publish() ─▶ repack (public bucket rewrite)
 *        │                            └─ upload each Lambda asset  (S3 — MOCKED)
 *        │                            └─ upload repacked template  (S3 — MOCKED)
 *        ▼
 *   { templateUrl, quickCreateUrl, ... }  ─▶ hand the URL to the customer
 *
 * AWS-BLOCKED (documented, see decision-record-u2.md): the real S3 upload and
 * the create-stack → CREATE_COMPLETE proof require AWS credentials that are not
 * available in this environment.
 */
import { App } from 'aws-cdk-lib';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BootstrapStack } from '../bootstrap/bootstrap-stack.js';
import { buildBootstrapQuickCreateUrl } from './install-link.js';
import { requireWithinLimits } from './limits.js';
import { repackTemplate } from './repack.js';

type JsonObject = Record<string, unknown>;

/** S3 put-object abstraction — the single AWS seam (mocked in tests). */
export interface S3Client {
  putObject(params: {
    readonly key: string;
    readonly body: Uint8Array | string;
    readonly contentType?: string;
  }): Promise<void>;
}

/** A bundled Lambda code asset produced by synth, ready to be published. */
export interface TemplateAsset {
  /** Source hash (matches the template's `Code.S3Key` `<hash>.zip`). */
  readonly sourceHash: string;
  /** S3 object key suffix the asset is published to (e.g. `<hash>.zip`). */
  readonly objectKey: string;
  /** Absolute path to the esbuild-bundled asset directory on disk. */
  readonly sourcePath: string;
}

/** Result of synthesizing the bootstrap stack (template + bundled assets). */
export interface SynthOutput {
  readonly template: JsonObject;
  readonly assets: TemplateAsset[];
}

export interface SynthesizeOptions {
  /** Output directory for the cloud assembly (temp dir is fine). */
  readonly outdir: string;
  /** Control-plane URL baked into the template default (non-secret). */
  readonly controlPlaneUrl?: string;
  /** CDK stack id. Defaults to `DeployzBootstrap`. */
  readonly stackId?: string;
}

interface AssetManifestEntry {
  readonly source?: { readonly path?: string; readonly packaging?: string };
}

interface AssetManifest {
  readonly files?: Record<string, AssetManifestEntry>;
}

/** Reads the bundled bytes of a Lambda asset from disk (mockable seam). */
export type AssetReader = (asset: TemplateAsset) => Promise<Uint8Array>;

/**
 * Default asset reader: returns the esbuild bundle entry (`index.mjs`) bytes.
 *
 * For a `format: 'esm'` NodejsFunction, esbuild emits a single `index.mjs`
 * (plus an optional `index.mjs.map` for source-mapped bundles). The final
 * Lambda deployment package is a ZIP containing that file; wrapping the bundle
 * into the ZIP container is part of the AWS-enabled asset-publishing step
 * (todo 14 harness) and is BLOCKED here — a ZIP is only verifiable by actually
 * invoking a Lambda from it, which needs AWS.
 */
export async function readBundledIndexMjs(
  asset: TemplateAsset,
): Promise<Uint8Array> {
  const bytes = await readFile(join(asset.sourcePath, 'index.mjs'));
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Synthesizes the bootstrap stack and returns its template + the bundled
 * Lambda assets (with their on-disk locations) by reading the cloud assembly's
 * asset manifest. No AWS calls.
 */
export async function synthesizeBootstrapStack(
  options: SynthesizeOptions,
): Promise<SynthOutput> {
  const app = new App({ outdir: options.outdir });
  const stackId = options.stackId ?? 'DeployzBootstrap';
  const stack = new BootstrapStack(app, stackId, {
    ...(options.controlPlaneUrl !== undefined
      ? { controlPlaneUrl: options.controlPlaneUrl }
      : {}),
  });

  const assembly = app.synth();
  const artifact = assembly.getStackArtifact(stack.artifactId);
  const template = artifact.template as JsonObject;

  const manifestPath = join(assembly.directory, `${stack.artifactId}.assets.json`);
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw) as AssetManifest;

  const assets: TemplateAsset[] = [];
  for (const [hash, entry] of Object.entries(manifest.files ?? {})) {
    // Only the Lambda code assets (packaging "zip"); skip the template-file
    // entry (packaging "file") — the publisher uploads the repacked template.
    if (entry.source?.packaging !== 'zip') continue;
    assets.push({
      sourceHash: hash,
      objectKey: `${hash}.zip`,
      sourcePath: join(assembly.directory, entry.source.path ?? ''),
    });
  }

  return { template, assets };
}

export interface PublishBootstrapOptions {
  /** AWS region of the public bucket + console deep-link. */
  readonly region: string;
  /** Public S3 bucket name. */
  readonly bucket: string;
  /** Key prefix under the bucket (e.g. `deployz/bootstrap/v1`). */
  readonly keyPrefix: string;
  /** Control-plane URL carried in the Quick Create link (non-secret). */
  readonly controlPlaneUrl: string;
  /** CloudFormation stack name in the Quick Create link. */
  readonly stackName?: string;
}

export interface PublishResult {
  /** S3 key of the published template. */
  readonly templateKey: string;
  /** Public HTTPS URL of the published template. */
  readonly templateUrl: string;
  /** Generated CloudFormation Quick Create deep-link. */
  readonly quickCreateUrl: string;
  /** S3 keys of the published Lambda assets (public). */
  readonly assetKeys: string[];
  /** Byte size of the repacked template. */
  readonly templateBytes: number;
  /** Parameter count of the repacked template. */
  readonly parameterCount: number;
}

export class BootstrapPublisher {
  constructor(
    private readonly s3: S3Client,
    private readonly options: PublishBootstrapOptions,
  ) {}

  /**
   * Publishes a synthesized bootstrap stack: repacks the template to be
   * self-contained, uploads the Lambda assets + repacked template, and returns
   * the public template URL + the Quick Create link.
   *
   * The S3 uploads go through the injected `S3Client`; `readAsset` is the
   * (mockable) asset-bytes seam. Fails fast if the repacked template exceeds
   * the CFN limits.
   */
  async publish(
    synth: SynthOutput,
    readAsset: AssetReader = readBundledIndexMjs,
  ): Promise<PublishResult> {
    const { template: repacked } = repackTemplate(synth.template, {
      bucket: this.options.bucket,
      keyPrefix: this.options.keyPrefix,
    });

    // Fail fast: never hand a customer an over-limit template.
    const limits = requireWithinLimits(repacked);

    // Upload each bundled Lambda asset to its public location.
    const assetKeys: string[] = [];
    for (const asset of synth.assets) {
      const key = `${this.options.keyPrefix}/${asset.objectKey}`;
      const body = await readAsset(asset);
      await this.s3.putObject({ key, body, contentType: 'application/zip' });
      assetKeys.push(key);
    }

    // Upload the repacked (self-contained) template.
    const templateKey = `${this.options.keyPrefix}/bootstrap-template-v1.json`;
    await this.s3.putObject({
      key: templateKey,
      body: JSON.stringify(repacked, null, 2),
      contentType: 'application/json',
    });

    const templateUrl = this.publicUrl(templateKey);
    const quickCreateUrl = buildBootstrapQuickCreateUrl({
      region: this.options.region,
      templateUrl,
      controlPlaneUrl: this.options.controlPlaneUrl,
      ...(this.options.stackName !== undefined
        ? { stackName: this.options.stackName }
        : {}),
    });

    return {
      templateKey,
      templateUrl,
      quickCreateUrl,
      assetKeys,
      templateBytes: limits.bytes,
      parameterCount: limits.parameterCount,
    };
  }

  private publicUrl(key: string): string {
    return `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${key}`;
  }
}

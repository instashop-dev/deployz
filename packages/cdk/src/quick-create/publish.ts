/**
 * Bootstrap template publisher — synthesizes the bootstrap stack, repacks the
 * template to be self-contained, and uploads the template + bundled Lambda
 * assets to a PUBLIC S3 location the customer's CloudFormation can resolve.
 *
 * The S3 upload is the ONLY AWS-dependent step; everything else (synth, repack,
 * URL construction, limits) is local and fully testable. The upload is
 * performed through an injectable `S3Client` interface so tests exercise the
 * full publish flow with a mock and no AWS credentials.
 */
import { App } from 'aws-cdk-lib';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  S3Client as SdkS3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import { ApplicationStack } from '../application/application-stack.js';
import { DOCUMENSO_APPLICATION_PROPS } from '../application/documenso.js';
import { BootstrapStack } from '../bootstrap/bootstrap-stack.js';
import {
  APPLICATION_TEMPLATE_KEY,
  APPLICATION_TEMPLATE_REDIS_KEY,
  buildBootstrapQuickCreateUrl,
} from '@deployz/contracts';
import { requireWithinLimits } from './limits.js';
import { repackTemplate } from './repack.js';
import { createZip, type ZipEntry } from './zip.js';

type JsonObject = Record<string, unknown>;

/** S3 put-object abstraction — the single AWS seam (mocked in tests). */
export interface S3Client {
  putObject(params: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array | string;
    readonly contentType?: string;
  }): Promise<void>;
}

let sdkS3: SdkS3Client | undefined;

function getSdkS3(): SdkS3Client {
  if (!sdkS3) {
    sdkS3 = new SdkS3Client({});
  }
  return sdkS3;
}

export function createRealS3Client(): S3Client {
  return {
    async putObject(params) {
      await getSdkS3().send(
        new PutObjectCommand({
          Bucket: params.bucket,
          Key: params.key,
          Body: params.body,
          ContentType: params.contentType,
        }),
      );
    },
  };
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
  /**
   * Published application-template URL baked into the template default.
   *
   * This is what the relay's INSTALL executor hands CloudFormation as
   * `TemplateURL`. Publish the application template first; without this the
   * bootstrap template ships with an empty default and every install fails
   * with "no application template URL is configured".
   */
  readonly applicationTemplateUrl?: string;
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

/** Every file under `dir`, as archive-relative POSIX paths. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await listFiles(join(dir, entry.name), name)));
    } else {
      found.push(name);
    }
  }
  return found;
}

/**
 * Default asset reader: ZIPs the asset directory that CDK's esbuild bundling
 * produced (`index.mjs`, plus its source map when one was emitted).
 *
 * A Lambda `Code.S3Key` must be a ZIP archive. Publishing the bare bundle
 * instead fails stack creation in the CUSTOMER's account with "Could not
 * unzip uploaded file" — after IAM roles have already been created, so they
 * see a rollback rather than an install.
 */
export async function readBundledIndexMjs(
  asset: TemplateAsset,
): Promise<Uint8Array> {
  const names = (await listFiles(asset.sourcePath)).sort();
  const entries: ZipEntry[] = [];
  for (const name of names) {
    const bytes = await readFile(join(asset.sourcePath, ...name.split('/')));
    entries.push({ name, content: new Uint8Array(bytes) });
  }
  const zip = createZip(entries);
  return new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength);
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
    ...(options.applicationTemplateUrl !== undefined
      ? { applicationTemplateUrl: options.applicationTemplateUrl }
      : {}),
  });

  const assembly = app.synth();
  const artifact = assembly.getStackArtifact(stack.artifactId);

  return {
    template: artifact.template as JsonObject,
    assets: await readZipAssets(assembly.directory, stack.artifactId),
  };
}

/**
 * The bundled Lambda code assets a synthesized stack refers to, read from
 * the cloud assembly's asset manifest.
 *
 * Only the `zip` entries — the `file` entry is the template itself, which
 * the publisher uploads in its repacked form. A stack with no Lambdas (the
 * application stack, today) simply yields none.
 */
async function readZipAssets(directory: string, artifactId: string): Promise<TemplateAsset[]> {
  const manifestPath = join(directory, `${artifactId}.assets.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifest;

  const assets: TemplateAsset[] = [];
  for (const [hash, entry] of Object.entries(manifest.files ?? {})) {
    if (entry.source?.packaging !== 'zip') continue;
    assets.push({
      sourceHash: hash,
      objectKey: `${hash}.zip`,
      sourcePath: join(directory, entry.source.path ?? ''),
    });
  }
  return assets;
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
      await this.s3.putObject({
          bucket: this.options.bucket,
          key,
          body,
          contentType: 'application/zip',
        });
      assetKeys.push(key);
    }

    // Upload the repacked (self-contained) template.
    const templateKey = `${this.options.keyPrefix}/bootstrap-template-v1.json`;
await this.s3.putObject({
        bucket: this.options.bucket,
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

// ── Application template ────────────────────────────────────────────────────

export { APPLICATION_TEMPLATE_KEY, APPLICATION_TEMPLATE_REDIS_KEY };

export interface SynthesizeApplicationOptions {
  /** Output directory for the cloud assembly (temp dir is fine). */
  readonly outdir: string;
  /** CDK stack id. Defaults to `DeployzApplication`. */
  readonly stackId?: string;
  /** Container image repository the published template runs. */
  readonly imageRepository?: string;
  /** Container image digest (immutable `sha256:` reference). */
  readonly imageDigest?: string;
  /** Provision an ElastiCache Valkey cache alongside the application. */
  readonly redisRequired?: boolean;
  /**
   * Vendor application preset. When set, the preset's `ApplicationStackProps`
   * are spread into the stack — `'documenso'` applies
   * `DOCUMENSO_APPLICATION_PROPS` (container contract, health check, and
   * secret parameters for the Documenso application).
   */
  readonly preset?: 'documenso';
}

/**
 * Synthesizes the application stack — the template the relay's INSTALL
 * executor creates a stack from.
 *
 * Two choices are fixed here rather than left to the caller, because a
 * published template that gets either wrong is one no install can ever
 * verify:
 *
 * - **`expressMode: false`.** `verifyInstallation` requires an
 *   `AWS::ECS::Service` and an `AWS::ElasticLoadBalancingV2::LoadBalancer`.
 *   An express-mode stack has neither — it uses
 *   `AWS::ECS::ExpressGatewayService` and lets ECS manage the load balancer
 *   — so a correctly provisioned express install would fail verification
 *   and be reported as a failed install.
 *
 * - **`allowInsecureHttp: true`.** The certificate for a deployment's
 *   custom domain does not exist at publish time; it is requested later,
 *   per installation, by the CONFIGURE_DOMAIN executor, which then adds the
 *   HTTPS listener to this stack's ALB. The published template therefore
 *   ships with an HTTP listener and no silent pretence of TLS.
 *
 * No AWS calls.
 */
export async function synthesizeApplicationStack(
  options: SynthesizeApplicationOptions,
): Promise<SynthOutput> {
  const app = new App({ outdir: options.outdir });
  const stack = new ApplicationStack(app, options.stackId ?? 'DeployzApplication', {
    expressMode: false,
    allowInsecureHttp: true,
    ...(options.preset === 'documenso' ? DOCUMENSO_APPLICATION_PROPS : {}),
    ...(options.imageRepository !== undefined
      ? { imageRepository: options.imageRepository }
      : {}),
    ...(options.imageDigest !== undefined ? { imageDigest: options.imageDigest } : {}),
    ...(options.redisRequired !== undefined ? { redisRequired: options.redisRequired } : {}),
  });

  const assembly = app.synth();
  const artifact = assembly.getStackArtifact(stack.artifactId);

  return {
    template: artifact.template as JsonObject,
    assets: await readZipAssets(assembly.directory, stack.artifactId),
  };
}

export interface PublishApplicationOptions {
  /** AWS region of the public bucket. */
  readonly region: string;
  /** Public S3 bucket name. */
  readonly bucket: string;
  /** Key prefix under the bucket (e.g. `application/v1`). */
  readonly keyPrefix: string;
}

export interface ApplicationPublishResult {
  /** S3 key of the published template. */
  readonly templateKey: string;
  /**
   * Public HTTPS URL of the published template.
   *
   * This is the value the bootstrap stack carries into the relay as
   * `DEPLOYZ_APPLICATION_TEMPLATE_URL` — `CreateStack`'s `TemplateURL`.
   */
  readonly templateUrl: string;
  /** S3 keys of any published Lambda assets (public). */
  readonly assetKeys: string[];
  /** Byte size of the repacked template. */
  readonly templateBytes: number;
  /** Parameter count of the repacked template. */
  readonly parameterCount: number;
}

/**
 * Publishes the application template to the same public bucket the
 * bootstrap template lives in, under its own key prefix.
 *
 * Separate from `BootstrapPublisher` rather than a mode of it: the two
 * produce different artifacts for different readers. The bootstrap template
 * is handed to a human through a Quick Create link and needs one built;
 * this one is fetched by CloudFormation on the relay's behalf and needs no
 * link at all.
 */
export class ApplicationPublisher {
  constructor(
    private readonly s3: S3Client,
    private readonly options: PublishApplicationOptions,
  ) {}

  async publish(
    synth: SynthOutput,
    readAsset: AssetReader = readBundledIndexMjs,
    templateKeyName: string = APPLICATION_TEMPLATE_KEY,
  ): Promise<ApplicationPublishResult> {
    const { template: repacked } = repackTemplate(synth.template, {
      bucket: this.options.bucket,
      keyPrefix: this.options.keyPrefix,
    });

    // Fail fast: an over-limit template is rejected at CreateStack time, in
    // the customer's account, as a failed install.
    const limits = requireWithinLimits(repacked);

    const assetKeys: string[] = [];
    for (const asset of synth.assets) {
      const key = `${this.options.keyPrefix}/${asset.objectKey}`;
      await this.s3.putObject({
        bucket: this.options.bucket,
        key,
        body: await readAsset(asset),
        contentType: 'application/zip',
      });
      assetKeys.push(key);
    }

    const templateKey = `${this.options.keyPrefix}/${templateKeyName}`;
    await this.s3.putObject({
      bucket: this.options.bucket,
      key: templateKey,
      body: JSON.stringify(repacked, null, 2),
      contentType: 'application/json',
    });

    return {
      templateKey,
      templateUrl: `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${templateKey}`,
      assetKeys,
      templateBytes: limits.bytes,
      parameterCount: limits.parameterCount,
    };
  }
}

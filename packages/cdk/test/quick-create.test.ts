import { describe, it, expect } from 'vitest';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  buildQuickCreateUrl,
  buildBootstrapQuickCreateUrl,
  DEFAULT_BOOTSTRAP_STACK_NAME,
  CONTROL_PLANE_URL_PARAMETER,
} from '../src/quick-create/install-link.js';
import {
  CFN_TEMPLATE_MAX_BYTES,
  CFN_TEMPLATE_MAX_PARAMS,
  assertTemplateLimits,
  countParameters,
  requireWithinLimits,
} from '../src/quick-create/limits.js';
import { repackTemplate } from '../src/quick-create/repack.js';
import { phaseOf, QuickCreateOrchestrator } from '../src/quick-create/orchestration.js';
import {
  APPLICATION_TEMPLATE_KEY,
  APPLICATION_TEMPLATE_REDIS_KEY,
  ApplicationPublisher,
  BootstrapPublisher,
  publishBootstrapToAllRegions,
  synthesizeApplicationStack,
  synthesizeBootstrapStack,
  verifyPublishedRegion,
  type RegionVerifier,
  type S3Client,
} from '../src/quick-create/publish.js';
import {
  APPLICATION_TEMPLATE_KEY as CONTRACTS_APPLICATION_TEMPLATE_KEY,
  APPLICATION_TEMPLATE_REDIS_KEY as CONTRACTS_APPLICATION_TEMPLATE_REDIS_KEY,
} from '@deployz/contracts';

describe('quick-create', () => {
  describe('install-link generator', () => {
    const templateUrl =
      'https://my-bucket.s3.us-east-1.amazonaws.com/deployz/bootstrap/template.json';

    it('builds a deterministic Quick Create URL with templateURL, stack name and params', () => {
      const url = buildQuickCreateUrl({
        region: 'us-east-1',
        templateUrl,
        parameters: { [CONTROL_PLANE_URL_PARAMETER]: 'https://api.deployz.dev' },
      });

      expect(url).toBe(
        'https://us-east-1.console.aws.amazon.com/cloudformation/home' +
          '?region=us-east-1' +
          '#/stacks/create/review' +
          '?templateURL=https%3A%2F%2Fmy-bucket.s3.us-east-1.amazonaws.com%2Fdeployz%2Fbootstrap%2Ftemplate.json' +
          '&stackName=deployz-bootstrap' +
          '&param_ControlPlaneUrl=https%3A%2F%2Fapi.deployz.dev',
      );
    });

    it('defaults the stack name to deployz-bootstrap', () => {
      const url = buildQuickCreateUrl({ region: 'us-west-2', templateUrl });
      expect(url).toContain(`stackName=${DEFAULT_BOOTSTRAP_STACK_NAME}`);
    });

    it('uses a custom stack name when provided', () => {
      const url = buildQuickCreateUrl({
        region: 'us-west-2',
        templateUrl,
        stackName: 'acme-deployz',
      });
      expect(url).toContain('stackName=acme-deployz');
    });

    it('URL-encodes the template URL so it survives the console fragment query', () => {
      const url = buildQuickCreateUrl({ region: 'eu-west-1', templateUrl });
      expect(url).toContain('templateURL=https%3A%2F%2Fmy-bucket.s3.');
      // No raw `://` in the query string — it is percent-encoded.
      expect(url.split('?templateURL=')[1]?.startsWith('https%3A%2F%2F')).toBe(
        true,
      );
    });

    it('prefixes every template parameter with param_', () => {
      const url = buildQuickCreateUrl({
        region: 'us-east-1',
        templateUrl,
        parameters: { DbName: 'mywpblog', InstanceType: 't2.medium' },
      });
      expect(url).toContain('&param_DbName=mywpblog');
      expect(url).toContain('&param_InstanceType=t2.medium');
    });

    it('buildBootstrapQuickCreateUrl carries ONLY the non-secret ControlPlaneUrl', () => {
      const url = buildBootstrapQuickCreateUrl({
        region: 'us-east-1',
        templateUrl,
        controlPlaneUrl: 'https://api.deployz.dev',
      });
      expect(url).toContain(
        `param_${CONTROL_PLANE_URL_PARAMETER}=https%3A%2F%2Fapi.deployz.dev`,
      );
    });

    it('never carries a credential or installation identifier (no secret leakage)', () => {
      const url = buildBootstrapQuickCreateUrl({
        region: 'us-east-1',
        templateUrl,
        controlPlaneUrl: 'https://api.deployz.dev',
      });
      // A bootstrap-generated token / minted install id must never appear.
      const secretToken = 'super-secret-relay-token-0123456789';
      const installationId = '11111111-2222-3333-4444-555555555555';
      expect(url).not.toContain(secretToken);
      expect(url).not.toContain(installationId);
      expect(url).not.toMatch(/token|credential|password/i);
    });
  });

  describe('template limits (CFN spec)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const readArtifact = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(here, '..', 'artifacts', name), 'utf8')) as Record<
        string,
        unknown
      >;

    it('bootstrap template is within byte + parameter limits', () => {
      const template = readArtifact('bootstrap-template-v1.json');
      const report = assertTemplateLimits(template);
      expect(report.bytes).toBeLessThanOrEqual(CFN_TEMPLATE_MAX_BYTES);
      expect(report.parameterCount).toBeLessThanOrEqual(CFN_TEMPLATE_MAX_PARAMS);
      expect(report.withinLimits).toBe(true);
    });

    it('application template is within byte + parameter limits', () => {
      const template = readArtifact('application-template-v1.json');
      const report = assertTemplateLimits(template);
      expect(report.bytes).toBeLessThanOrEqual(CFN_TEMPLATE_MAX_BYTES);
      expect(report.parameterCount).toBeLessThanOrEqual(CFN_TEMPLATE_MAX_PARAMS);
      expect(report.withinLimits).toBe(true);
    });

    it('reports the actual byte size and parameter count', () => {
      const bootstrap = readArtifact('bootstrap-template-v1.json');
      const app = readArtifact('application-template-v1.json');
      const b = assertTemplateLimits(bootstrap);
      const a = assertTemplateLimits(app);
      // Sanity: the committed artifacts are non-trivial but far under the limit.
      expect(b.bytes).toBeGreaterThan(0);
      expect(a.bytes).toBeGreaterThan(0);
      expect(countParameters(bootstrap)).toBe(b.parameterCount);
      expect(countParameters(app)).toBe(a.parameterCount);
    });

    it('requireWithinLimits throws when a template exceeds the byte limit', () => {
      const oversized = {
        Parameters: {},
        Resources: { Padding: { Type: 'AWS::S3::Bucket', Properties: { Pad: 'x'.repeat(CFN_TEMPLATE_MAX_BYTES) } } },
      };
      expect(() => requireWithinLimits(oversized)).toThrow(/exceeds CloudFormation limits/);
    });
  });

  describe('template repack', () => {
    const cdkTemplate = {
      Parameters: {
        ControlPlaneUrl: { Type: 'String' },
        BootstrapVersion: { Type: 'String' },
      },
      Rules: {
        CheckBootstrapVersion: { Assertions: [{ Assert: { 'Fn::Not': [] } }] },
      },
      Resources: {
        RelayFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Code: {
              S3Bucket: { 'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}' },
              S3Key: 'abc123def456.zip',
            },
          },
        },
      },
    };

    it('rewrites Lambda Code to the public bucket + key prefix', () => {
      const { template, assetHashes } = repackTemplate(cdkTemplate, {
        bucket: 'deployz-public',
        keyPrefix: 'deployz/bootstrap/v1',
      });

      const code = (template.Resources as Record<string, { Properties: { Code: Record<string, unknown> } }>)['RelayFn']
        .Properties.Code;
      expect(code.S3Bucket).toBe('deployz-public');
      expect(code.S3Key).toBe('deployz/bootstrap/v1/abc123def456.zip');
      expect(assetHashes).toEqual(['abc123def456']);
    });

    it('strips the BootstrapVersion parameter and CheckBootstrapVersion rule', () => {
      const { template } = repackTemplate(cdkTemplate, {
        bucket: 'deployz-public',
        keyPrefix: 'deployz/bootstrap/v1',
      });
      expect(template.Parameters).toBeDefined();
      expect(template.Parameters).not.toHaveProperty('BootstrapVersion');
      expect(template.Rules).toBeUndefined();
    });

    it('does not mutate the input template', () => {
      const snapshot = JSON.stringify(cdkTemplate);
      repackTemplate(cdkTemplate, {
        bucket: 'deployz-public',
        keyPrefix: 'deployz/bootstrap/v1',
      });
      expect(JSON.stringify(cdkTemplate)).toBe(snapshot);
    });

    it('leaves a template with no Lambdas intact except bootstrap scaffolding', () => {
      const appLike = {
        Parameters: {
          paramAppApiKey: { Type: 'String', NoEcho: true },
          BootstrapVersion: { Type: 'String' },
        },
        Rules: { CheckBootstrapVersion: { Assertions: [] } },
        Resources: { Bucket: { Type: 'AWS::S3::Bucket' } },
      };
      const { template, assetHashes } = repackTemplate(appLike, {
        bucket: 'deployz-public',
        keyPrefix: 'deployz/app/v1',
      });
      expect(assetHashes).toEqual([]);
      expect(template.Parameters).not.toHaveProperty('BootstrapVersion');
      expect(template.Parameters).toHaveProperty('paramAppApiKey');
      expect(template.Rules).toBeUndefined();
    });
  });

  describe('two-phase orchestration', () => {
    it('walks the full happy path through both phases', () => {
      const o = new QuickCreateOrchestrator();
      expect(o.state).toBe('UNPUBLISHED');
      expect(o.phase).toBe('PHASE_1_BOOTSTRAP');

      expect(
        o.transition({
          type: 'bootstrap.published',
          templateUrl: 'https://s3/.../template.json',
          quickCreateUrl: 'https://console.aws.amazon.com/...',
        }).accepted,
      ).toBe(true);
      expect(o.state).toBe('BOOTSTRAP_PUBLISHED');

      expect(o.transition({ type: 'customer.create_started' }).accepted).toBe(true);
      expect(o.state).toBe('CUSTOMER_CREATING');
      expect(o.phase).toBe('PHASE_1_BOOTSTRAP');

      expect(
        o.transition({ type: 'relay.first_contact', installationId: 'inst-1' }).accepted,
      ).toBe(true);
      expect(o.state).toBe('REGISTERING_INSTALL');
      expect(o.phase).toBe('PHASE_2_APPLICATION');
      expect(o.installationId).toBe('inst-1');

      expect(o.transition({ type: 'preflight.passed' }).accepted).toBe(true);
      expect(o.state).toBe('PREFLIGHTING');

      expect(o.transition({ type: 'relay.callback' }).accepted).toBe(true);
      expect(o.state).toBe('CREATING_APPLICATION');

      expect(o.transition({ type: 'application.create_complete' }).accepted).toBe(true);
      expect(o.state).toBe('APPLICATION_CREATED');
      expect(o.isComplete).toBe(true);
    });

    it('allows relay first contact directly after publish (no observed link click)', () => {
      const o = new QuickCreateOrchestrator();
      o.transition({
        type: 'bootstrap.published',
        templateUrl: 'https://s3/t.json',
        quickCreateUrl: 'https://console/qc',
      });
      expect(
        o.transition({ type: 'relay.first_contact', installationId: 'inst-2' }).accepted,
      ).toBe(true);
      expect(o.state).toBe('REGISTERING_INSTALL');
    });

    it('rejects an illegal transition without mutating state', () => {
      const o = new QuickCreateOrchestrator();
      const result = o.transition({ type: 'relay.first_contact', installationId: 'x' });
      expect(result.accepted).toBe(false);
      expect(result.from).toBe('UNPUBLISHED');
      expect(result.to).toBe('UNPUBLISHED');
      expect(o.state).toBe('UNPUBLISHED');
      expect(o.installationId).toBeUndefined();
    });

    it('rejects preflight before first contact', () => {
      const o = new QuickCreateOrchestrator();
      o.transition({
        type: 'bootstrap.published',
        templateUrl: 'https://s3/t.json',
        quickCreateUrl: 'https://console/qc',
      });
      expect(o.transition({ type: 'preflight.passed' }).accepted).toBe(false);
      expect(o.state).toBe('BOOTSTRAP_PUBLISHED');
    });

    it('a failure is terminal and records its phase', () => {
      const o = new QuickCreateOrchestrator();
      o.transition({
        type: 'bootstrap.published',
        templateUrl: 'https://s3/t.json',
        quickCreateUrl: 'https://console/qc',
      });
      o.transition({ type: 'customer.create_started' });
      expect(o.transition({ type: 'failed', reason: 'customer cancelled' }).accepted).toBe(true);
      expect(o.state).toBe('FAILED');
      expect(o.isFailed).toBe(true);
      expect(o.failureReason).toBe('customer cancelled');
      expect(o.phase).toBe('PHASE_1_BOOTSTRAP');
      // Terminal — no further transition is accepted.
      expect(o.transition({ type: 'relay.first_contact', installationId: 'x' }).accepted).toBe(false);
    });

    it('records every accepted transition in history', () => {
      const o = new QuickCreateOrchestrator();
      o.transition({
        type: 'bootstrap.published',
        templateUrl: 'https://s3/t.json',
        quickCreateUrl: 'https://console/qc',
      });
      o.transition({ type: 'relay.first_contact', installationId: 'inst-3' });
      expect(o.history).toHaveLength(2);
      expect(o.history[0]?.to).toBe('BOOTSTRAP_PUBLISHED');
      expect(o.history[1]?.to).toBe('REGISTERING_INSTALL');
    });

    it('classifies phase 2 states via phaseOf', () => {
      expect(phaseOf('REGISTERING_INSTALL')).toBe('PHASE_2_APPLICATION');
      expect(phaseOf('PREFLIGHTING')).toBe('PHASE_2_APPLICATION');
      expect(phaseOf('CREATING_APPLICATION')).toBe('PHASE_2_APPLICATION');
      expect(phaseOf('APPLICATION_CREATED')).toBe('PHASE_2_APPLICATION');
      expect(phaseOf('UNPUBLISHED')).toBe('PHASE_1_BOOTSTRAP');
    });
  });

  describe('bootstrap publisher (mock S3)', () => {
    const region = 'us-east-1';
    const bucket = 'deployz-public-assets';
    const keyPrefix = 'deployz/bootstrap/v1';

    function mockS3() {
      const uploads: Array<{ key: string; body: Uint8Array | string; contentType?: string }> = [];
      return {
        client: {
          async putObject(params: {
            bucket: string;
            key: string;
            body: Uint8Array | string;
            contentType?: string;
          }): Promise<void> {
            uploads.push(params);
          },
        },
        uploads,
      };
    }

    const syntheticTemplate = {
      Parameters: {
        ControlPlaneUrl: { Type: 'String' },
        BootstrapVersion: { Type: 'String' },
      },
      Rules: { CheckBootstrapVersion: { Assertions: [] } },
      Resources: {
        RelayFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Code: {
              S3Bucket: { 'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}' },
              S3Key: 'abc123def456.zip',
            },
          },
        },
      },
    };

    it('uploads the repacked template + Lambda assets and returns the URLs', async () => {
      const { client, uploads } = mockS3();
      const publisher = new BootstrapPublisher(client, {
        region,
        bucket,
        keyPrefix,
        controlPlaneUrl: 'https://api.deployz.dev',
      });

      const result = await publisher.publish(
        {
          template: syntheticTemplate,
          assets: [
            {
              sourceHash: 'abc123def456',
              objectKey: 'abc123def456.zip',
              sourcePath: '/fake/asset',
            },
          ],
        },
        async () => new Uint8Array([0x1f, 0x8b]),
      );

      // 1 Lambda asset + 1 template.
      expect(uploads).toHaveLength(2);

      const assetUpload = uploads.find((u) => u.key === `${keyPrefix}/abc123def456.zip`);
      expect(assetUpload).toBeDefined();
      expect(assetUpload?.contentType).toBe('application/zip');

      const templateUpload = uploads.find(
        (u) => u.key === `${keyPrefix}/bootstrap-template-v1.json`,
      );
      expect(templateUpload).toBeDefined();
      expect(templateUpload?.contentType).toBe('application/json');

      expect(result.templateUrl).toBe(
        `https://${bucket}.s3.${region}.amazonaws.com/${keyPrefix}/bootstrap-template-v1.json`,
      );
      expect(result.assetKeys).toEqual([`${keyPrefix}/abc123def456.zip`]);
      expect(result.quickCreateUrl).toContain(
        'templateURL=https%3A%2F%2Fdeployz-public-assets.s3.us-east-1.amazonaws.com%2Fdeployz%2Fbootstrap%2Fv1%2Fbootstrap-template-v1.json',
      );
      expect(result.quickCreateUrl).toContain(
        'param_ControlPlaneUrl=https%3A%2F%2Fapi.deployz.dev',
      );
    });

    it('rewrites the uploaded template to the public bucket (self-contained)', async () => {
      const { client, uploads } = mockS3();
      const publisher = new BootstrapPublisher(client, {
        region,
        bucket,
        keyPrefix,
        controlPlaneUrl: 'https://api.deployz.dev',
      });

      await publisher.publish(
        {
          template: syntheticTemplate,
          assets: [
            {
              sourceHash: 'abc123def456',
              objectKey: 'abc123def456.zip',
              sourcePath: '/fake/asset',
            },
          ],
        },
        async () => new Uint8Array([0x1f, 0x8b]),
      );

      const templateUpload = uploads.find(
        (u) => u.key === `${keyPrefix}/bootstrap-template-v1.json`,
      );
      const published = JSON.parse(String(templateUpload?.body)) as {
        Resources: Record<string, { Properties: { Code: Record<string, unknown> } }>;
        Parameters?: Record<string, unknown>;
        Rules?: Record<string, unknown>;
      };
      expect(published.Resources['RelayFn'].Properties.Code.S3Bucket).toBe(bucket);
      expect(published.Resources['RelayFn'].Properties.Code.S3Key).toBe(
        `${keyPrefix}/abc123def456.zip`,
      );
      expect(published.Parameters).not.toHaveProperty('BootstrapVersion');
      expect(published.Rules).toBeUndefined();
    });

    it('fails fast when the repacked template exceeds the CFN byte limit', async () => {
      const { client } = mockS3();
      const publisher = new BootstrapPublisher(client, {
        region,
        bucket,
        keyPrefix,
        controlPlaneUrl: 'https://api.deployz.dev',
      });

      const oversized = {
        Parameters: {},
        Resources: {
          Pad: { Type: 'AWS::S3::Bucket', Properties: { Pad: 'x'.repeat(CFN_TEMPLATE_MAX_BYTES) } },
        },
      };

      await expect(
        publisher.publish({ template: oversized, assets: [] }, async () => new Uint8Array()),
      ).rejects.toThrow(/exceeds CloudFormation limits/);
    });
  });

  describe('regional bootstrap publishing (mock S3 + verifier)', () => {
    const keyPrefix = 'bootstrap/v1';
    const controlPlaneUrl = 'https://api.deployz.dev';

    const syntheticTemplate = {
      Parameters: {
        ControlPlaneUrl: { Type: 'String' },
        BootstrapVersion: { Type: 'String' },
      },
      Rules: { CheckBootstrapVersion: { Assertions: [] } },
      Resources: {
        RelayFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Code: {
              S3Bucket: { 'Fn::Sub': 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}' },
              S3Key: 'abc123def456.zip',
            },
          },
        },
      },
    };

    const synth = {
      template: syntheticTemplate,
      assets: [
        {
          sourceHash: 'abc123def456',
          objectKey: 'abc123def456.zip',
          sourcePath: '/fake/asset',
        },
      ],
    };

    function makeS3Harness(): {
      s3For: (region: string) => S3Client;
      uploads: Map<string, Array<{ key: string; body: unknown; contentType?: string }>>;
    } {
      const uploads = new Map<
        string,
        Array<{ key: string; body: unknown; contentType?: string }>
      >();
      const s3 = (region: string): S3Client => ({
        async putObject(params) {
          const list = uploads.get(region) ?? [];
          list.push({ key: params.key, body: params.body, contentType: params.contentType });
          uploads.set(region, list);
        },
      });
      return { s3For: s3, uploads };
    }

    function passingVerifier(): RegionVerifier {
      return {
        // The deterministic bucket name embeds the region; report it back so
        // the region check passes for every supported bucket.
        getBucketLocation: async (bucket) => bucket.replace('deployz-templates-', ''),
        headObject: async () => true,
        fetchUrl: async () => 200,
        validateTemplate: async () => ({ valid: true }),
      };
    }

    it('publishes a repacked template + assets to every supported region bucket', async () => {
      const { s3For, uploads } = makeS3Harness();
      const verifierFor = () => passingVerifier();

      const results = await publishBootstrapToAllRegions(
        s3For,
        verifierFor,
        synth,
        { keyPrefix, controlPlaneUrl },
        async () => new Uint8Array([0x1f, 0x8b]),
      );

      // 17 supported regions, each with 1 asset + 1 template.
      expect(results).toHaveLength(17);
      for (const result of results) {
        expect(uploads.get(result.region)).toHaveLength(2);
        expect(result.templateUrl).toContain(`deployz-templates-${result.region}.s3.${result.region}`);
      }
    });

    it('rewrites the us-east-2 template to reference ONLY the us-east-2 bucket', async () => {
      const { s3For, uploads } = makeS3Harness();
      const verifierFor = () => passingVerifier();

      await publishBootstrapToAllRegions(
        s3For,
        verifierFor,
        synth,
        { keyPrefix, controlPlaneUrl },
        async () => new Uint8Array([0x1f, 0x8b]),
      );

      const usEast2Template = uploads
        .get('us-east-2')
        ?.find((u) => u.key === `${keyPrefix}/bootstrap-template-v1.json`);
      const published = JSON.parse(String(usEast2Template?.body)) as {
        Resources: Record<string, { Properties: { Code: Record<string, unknown> } }>;
      };
      // The critical regression this fix prevents: a us-east-2 stack must never
      // reference the us-east-1 bucket (S3 PermanentRedirect on Lambda create).
      expect(published.Resources['RelayFn'].Properties.Code.S3Bucket).toBe(
        'deployz-templates-us-east-2',
      );
      expect(published.Resources['RelayFn'].Properties.Code.S3Bucket).not.toBe(
        'deployz-templates-us-east-1',
      );
      expect(published.Resources['RelayFn'].Properties.Code.S3Key).toBe(
        `${keyPrefix}/abc123def456.zip`,
      );
    });

    it('reuses identical asset bytes across every region (built once)', async () => {
      const { s3For, uploads } = makeS3Harness();
      const verifierFor = () => passingVerifier();

      await publishBootstrapToAllRegions(
        s3For,
        verifierFor,
        synth,
        { keyPrefix, controlPlaneUrl },
        async () => new Uint8Array([0x1f, 0x8b, 0x08]),
      );

      const bodies = new Set<string>();
      for (const [, list] of uploads) {
        for (const upload of list) {
          if (upload.contentType === 'application/zip') {
            bodies.add(String(upload.body));
          }
        }
      }
      expect(bodies.size).toBe(1);
    });

    it('fails publishing when any region fails verification', async () => {
      const { s3For } = makeS3Harness();
      const verifierFor = () => ({
        getBucketLocation: async () => 'us-east-1',
        headObject: async () => true,
        fetchUrl: async () => 200,
        validateTemplate: async () => ({ valid: true }),
      });

      await expect(
        publishBootstrapToAllRegions(
          s3For,
          verifierFor,
          synth,
          { keyPrefix, controlPlaneUrl },
          async () => new Uint8Array([0x1f, 0x8b]),
        ),
      ).rejects.toThrow(/Bootstrap publishing failed for us-east-2/);
    });
  });

  describe('verifyPublishedRegion (fail closed)', () => {
    const bucket = 'deployz-templates-us-east-2';
    const keyPrefix = 'bootstrap/v1';
    const templateKey = `${keyPrefix}/bootstrap-template-v1.json`;
    const templateUrl = `https://${bucket}.s3.us-east-2.amazonaws.com/${templateKey}`;
    const assetKeys = [`${keyPrefix}/abc123def456.zip`];
    const repackedTemplate = {
      Resources: {
        RelayFn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Code: { S3Bucket: bucket, S3Key: `${keyPrefix}/abc123def456.zip` } },
        },
      },
    };

    function passingVerifier(): RegionVerifier {
      return {
        getBucketLocation: async () => 'us-east-2',
        headObject: async () => true,
        fetchUrl: async () => 200,
        validateTemplate: async () => ({ valid: true }),
      };
    }

    it('passes a correctly-published region', async () => {
      const result = await verifyPublishedRegion(passingVerifier(), {
        region: 'us-east-2',
        bucket,
        templateKey,
        templateUrl,
        repackedTemplate,
        assetKeys,
      });
      expect(result).toEqual({ ok: true });
    });

    it('fails when the bucket is in the wrong region', async () => {
      const verifier = passingVerifier();
      const result = await verifyPublishedRegion(
        { ...verifier, getBucketLocation: async () => 'us-east-1' },
        { region: 'us-east-2', bucket, templateKey, templateUrl, repackedTemplate, assetKeys },
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reasons.join('; ')).toContain('not us-east-2');
      }
    });

    it('fails when a referenced Lambda asset is missing', async () => {
      const verifier = passingVerifier();
      const result = await verifyPublishedRegion(
        { ...verifier, headObject: async (_bucket, key) => key === templateKey },
        { region: 'us-east-2', bucket, templateKey, templateUrl, repackedTemplate, assetKeys },
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reasons.join('; ')).toContain('missing');
      }
    });

    it('fails when Code.S3Bucket does not match the regional bucket', async () => {
      const verifier = passingVerifier();
      const wrongTemplate = {
        Resources: {
          RelayFn: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              Code: { S3Bucket: 'deployz-templates-us-east-1', S3Key: `${keyPrefix}/abc123def456.zip` },
            },
          },
        },
      };
      const result = await verifyPublishedRegion(verifier, {
        region: 'us-east-2',
        bucket,
        templateKey,
        templateUrl,
        repackedTemplate: wrongTemplate,
        assetKeys,
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reasons.join('; ')).toContain('Code.S3Bucket');
      }
    });
  });

  describe('synthesizeBootstrapStack (real synth, no AWS)', () => {
    it('synthesizes the bootstrap template and collects its bundled Lambda assets', async () => {
      const outdir = mkdtempSync(join(tmpdir(), 'deployz-qc-'));
      try {
        const synth = await synthesizeBootstrapStack({
          outdir,
          controlPlaneUrl: 'https://api.deployz.dev',
        });

        const resources = synth.template.Resources as Record<
          string,
          { Type: string; Properties: { Code?: { S3Key?: string } } }
        >;
        const lambdaKeys = Object.values(resources)
          .filter((r) => r.Type === 'AWS::Lambda::Function')
          .map((r) => r.Properties.Code?.S3Key)
          .filter((k): k is string => typeof k === 'string');

        expect(lambdaKeys.length).toBeGreaterThan(0);

        expect(synth.assets.length).toBe(lambdaKeys.length);
        const assetHashes = synth.assets.map((a) => a.sourceHash);
        for (const key of lambdaKeys) {
          const hash = key.replace(/\.zip$/, '');
          expect(assetHashes).toContain(hash);
        }

        expect(synth.template.Parameters).toHaveProperty('BootstrapVersion');
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });
  });

  // The application template is the artifact the relay's INSTALL executor
  // creates a stack from. Until it is published there is nothing to install:
  // `CreateStack` needs a `TemplateURL` CloudFormation can fetch.
  describe('application publisher (mock S3)', () => {
    const region = 'us-east-1';
    const bucket = 'deployz-public-assets';

    function mockS3() {
      const uploads: Array<{ key: string; body: Uint8Array | string; contentType?: string }> = [];
      return {
        client: {
          async putObject(params: {
            bucket: string;
            key: string;
            body: Uint8Array | string;
            contentType?: string;
          }): Promise<void> {
            uploads.push(params);
          },
        },
        uploads,
      };
    }

    const syntheticTemplate = {
      Parameters: {
        param_AppApiKey: { Type: 'String', NoEcho: true },
        BootstrapVersion: { Type: 'String' },
      },
      Rules: { CheckBootstrapVersion: { Assertions: [] } },
      Resources: {
        Service: { Type: 'AWS::ECS::Service', Properties: {} },
      },
    };

    it('publishes the application template beside the bootstrap one', async () => {
      const { client, uploads } = mockS3();
      const publisher = new ApplicationPublisher(client, {
        region,
        bucket,
        keyPrefix: 'application/v1',
      });

      const result = await publisher.publish({ template: syntheticTemplate, assets: [] });

      expect(result.templateKey).toBe('application/v1/application-template-v1.json');
      expect(result.templateUrl).toBe(
        'https://deployz-public-assets.s3.us-east-1.amazonaws.com/application/v1/application-template-v1.json',
      );
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.contentType).toBe('application/json');
    });

    it('strips the CDK bootstrap scaffolding so a fresh account can deploy it', async () => {
      const { client, uploads } = mockS3();
      const publisher = new ApplicationPublisher(client, {
        region,
        bucket,
        keyPrefix: 'application/v1',
      });

      await publisher.publish({ template: syntheticTemplate, assets: [] });

      const uploaded = JSON.parse(uploads[0]!.body as string) as Record<string, unknown>;
      expect(uploaded['Rules']).toBeUndefined();
      expect(uploaded['Parameters']).not.toHaveProperty('BootstrapVersion');
      expect(uploaded['Parameters']).toHaveProperty('param_AppApiKey');
    });

    it('refuses to publish a template over the CloudFormation limits', async () => {
      const { client } = mockS3();
      const publisher = new ApplicationPublisher(client, {
        region,
        bucket,
        keyPrefix: 'application/v1',
      });

      const tooManyParameters = {
        Parameters: Object.fromEntries(
          Array.from({ length: 61 }, (_, i) => [`p${i}`, { Type: 'String' }]),
        ),
        Resources: {},
      };

      await expect(
        publisher.publish({ template: tooManyParameters, assets: [] }),
      ).rejects.toThrow(/limits/);
    });

    it('publishes the Redis variant under its own key when a template key is given', async () => {
      const { client, uploads } = mockS3();
      const publisher = new ApplicationPublisher(client, {
        region,
        bucket,
        keyPrefix: 'application/v1',
      });

      const result = await publisher.publish(
        { template: syntheticTemplate, assets: [] },
        undefined,
        APPLICATION_TEMPLATE_REDIS_KEY,
      );

      expect(result.templateKey).toBe('application/v1/application-template-redis-v1.json');
      expect(result.templateUrl).toBe(
        'https://deployz-public-assets.s3.us-east-1.amazonaws.com/application/v1/application-template-redis-v1.json',
      );
      expect(uploads.find((u) => u.key === 'application/v1/application-template-v1.json')).toBeUndefined();
    });

    it('re-exports the template keys the relay derives the Redis URL from, unchanged', () => {
      expect(APPLICATION_TEMPLATE_KEY).toBe(CONTRACTS_APPLICATION_TEMPLATE_KEY);
      expect(APPLICATION_TEMPLATE_REDIS_KEY).toBe(CONTRACTS_APPLICATION_TEMPLATE_REDIS_KEY);
    });
  });

  describe('synthesizeApplicationStack (real synth, no AWS)', () => {
    it('synthesizes an installable application template', async () => {
      const outdir = mkdtempSync(join(tmpdir(), 'deployz-app-'));
      try {
        const synth = await synthesizeApplicationStack({ outdir });

        const resources = synth.template.Resources as Record<string, { Type: string }>;
        const types = Object.values(resources).map((r) => r.Type);

        // Exactly what `verifyInstallation` looks for after the install.
        expect(types).toContain('AWS::ECS::Service');
        expect(types).toContain('AWS::ElasticLoadBalancingV2::LoadBalancer');
        expect(types).toContain('AWS::RDS::DBInstance');
        expect(types).toContain('AWS::S3::Bucket');
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });

    it('does not use express mode — the verifier requires an ECS service and an ALB', async () => {
      const outdir = mkdtempSync(join(tmpdir(), 'deployz-app-'));
      try {
        const synth = await synthesizeApplicationStack({ outdir });

        const resources = synth.template.Resources as Record<string, { Type: string }>;
        const types = Object.values(resources).map((r) => r.Type);

        // An ExpressGatewayService has neither of the two resources
        // `verifyInstallation` requires, so a correctly provisioned
        // express-mode install could never verify.
        expect(types).not.toContain('AWS::ECS::ExpressGatewayService');
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });

    it('pins the container image the published template runs', async () => {
      const outdir = mkdtempSync(join(tmpdir(), 'deployz-app-'));
      try {
        const synth = await synthesizeApplicationStack({
          outdir,
          imageRepository: '1.dkr.ecr.us-east-1.amazonaws.com/deployz-images',
          imageDigest: 'sha256:abc',
        });

        expect(JSON.stringify(synth.template)).toContain(
          '1.dkr.ecr.us-east-1.amazonaws.com/deployz-images@sha256:abc',
        );
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });

    it('stays within the CloudFormation template limits', async () => {
      const outdir = mkdtempSync(join(tmpdir(), 'deployz-app-'));
      try {
        const synth = await synthesizeApplicationStack({ outdir });
        const report = assertTemplateLimits(synth.template);

        expect(report.withinLimits).toBe(true);
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });

    it('provisions no ElastiCache resources when redisRequired is unset', async () => {
      const outdir = mkdtempSync(join(tmpdir(), 'deployz-app-'));
      try {
        const synth = await synthesizeApplicationStack({ outdir });

        const resources = synth.template.Resources as Record<string, { Type: string }>;
        const types = Object.values(resources).map((r) => r.Type);

        expect(types).not.toContain('AWS::ElastiCache::ReplicationGroup');
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });

    it('provisions an ElastiCache Valkey cache when redisRequired is true', async () => {
      const outdir = mkdtempSync(join(tmpdir(), 'deployz-app-redis-'));
      try {
        const synth = await synthesizeApplicationStack({
          outdir,
          stackId: 'DeployzApplicationRedis',
          redisRequired: true,
        });

        const resources = synth.template.Resources as Record<string, { Type: string }>;
        const types = Object.values(resources).map((r) => r.Type);

        expect(types).toContain('AWS::ElastiCache::ReplicationGroup');
        expect(types).toContain('AWS::ElastiCache::SubnetGroup');
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });

    it('threads preset: "documenso" into the Documenso application props', async () => {
      const outdir = mkdtempSync(join(tmpdir(), 'deployz-app-'));
      try {
        const synth = await synthesizeApplicationStack({ outdir, preset: 'documenso' });
        const parameters = synth.template.Parameters as Record<string, unknown>;

        expect(Object.keys(parameters)).toContain('paramPublicUrl');
        expect(JSON.stringify(synth.template)).toContain('/api/health');
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });
  });
});

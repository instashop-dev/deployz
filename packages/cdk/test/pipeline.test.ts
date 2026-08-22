import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { BuildPipeline } from '../src/pipeline/build-pipeline.js';
import {
  ECR_PULL_ACTIONS,
  buildPullStatement,
  buildRepoPolicyDocument,
  grantPull,
  installationGrantSid,
  revokePull,
  type EcrClient,
  type EcrGrantStatement,
} from '../src/pipeline/ecr-grants.js';
import {
  fetchRepoArchive,
  needsStreaming,
  STREAMING_THRESHOLD_BYTES,
  type FetchFn,
  type FetchRepoArchiveOptions,
} from '../src/pipeline/source-fetch.js';
import type { S3Client } from '../src/quick-create/publish.js';

// ── CDK Pipeline Tests ───────────────────────────────────────────────────

describe('BuildPipeline', () => {
  function synth() {
    const app = new App();
    const stack = new Stack(app, 'PipelineTest', {
      env: { region: 'us-east-1' },
    });
    const pipeline = new BuildPipeline(stack, 'BuildPipeline');
    const template = Template.fromStack(stack);
    return { app, stack, pipeline, template };
  }

  it('synthesizes without errors', () => {
    const { template } = synth();
    expect(template).toBeDefined();
  });

  it('creates an ECR repository with immutable tags', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
    });
  });

  it('creates a CodeBuild project', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CodeBuild::Project', 1);
  });

  it('CodeBuild project uses privileged mode for Docker builds', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: {
        PrivilegedMode: true,
        ComputeType: 'BUILD_GENERAL1_SMALL',
      },
    });
  });

  it('CodeBuild project has ECR_REPOSITORY_URI environment variable', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: {
        EnvironmentVariables: [
          {
            Name: 'ECR_REPOSITORY_URI',
            Type: 'PLAINTEXT',
            Value: { 'Fn::Join': ['', Match.anyValue()] },
          },
        ],
      },
    });
  });

  it('buildspec includes ECR login, docker build, and digest recording phases', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Source: {
        Type: 'NO_SOURCE',
      },
      TimeoutInMinutes: 30,
    });
    // The buildspec is embedded as a JSON string — verify key phase commands
    // are present by checking the serialized Source property shape.
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    expect(project).toBeDefined();
    const sourceJson = JSON.stringify(project!.Properties!['Source']);
    // Key build phase should contain docker build
    expect(sourceJson).toContain('docker build');
    // Post-build phase should record the image digest
    expect(sourceJson).toContain('image-digest.txt');
  });

  it('never falls back to the mutable `latest` tag (§21)', () => {
    const { template } = synth();
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    expect(project).toBeDefined();
    const sourceJson = JSON.stringify(project!.Properties!['Source']);
    // No `:latest` fallback anywhere in the buildspec.
    expect(sourceJson).not.toContain(':-latest');
    expect(sourceJson).not.toContain('IMAGE_TAG=latest');
    // The tag falls back to a per-build-unique CodeBuild id, not a shared name.
    expect(sourceJson).toContain('CODEBUILD_BUILD_ID');
    // The build fails fast rather than silently using a mutable tag.
    expect(sourceJson).toContain('no usable image tag');
  });

  it('produces CloudFormation outputs for ECR URI and CodeBuild project name', () => {
    const { template } = synth();
    const json = template.toJSON() as { Outputs?: Record<string, unknown> };
    const outputs = Object.keys(json.Outputs ?? {});
    expect(outputs.some((o) => o.includes('EcrRepositoryUri'))).toBe(true);
    expect(outputs.some((o) => o.includes('CodeBuildProjectName'))).toBe(true);
  });

  it('ECR repository URI is non-empty', () => {
    const { pipeline } = synth();
    expect(pipeline.repository.repositoryUri).toBeTruthy();
  });

  it('CodeBuild project has a name', () => {
    const { pipeline } = synth();
    expect(pipeline.project.projectName).toBeTruthy();
  });

  it('accepts custom repository name', () => {
    const app = new App();
    const stack = new Stack(app, 'CustomRepo', {
      env: { region: 'us-east-1' },
    });
    new BuildPipeline(stack, 'CustomPipeline', {
      repositoryName: 'my-custom-images',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'my-custom-images',
    });
  });

  it('accepts custom compute type', async () => {
    const app = new App();
    const stack = new Stack(app, 'CustomCompute', {
      env: { region: 'us-east-1' },
    });
    const { ComputeType } = await import('aws-cdk-lib/aws-codebuild');
    new BuildPipeline(stack, 'CustomPipeline', {
      computeType: ComputeType.MEDIUM,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: {
        ComputeType: 'BUILD_GENERAL1_MEDIUM',
      },
    });
  });

  it('accepts custom timeout', () => {
    const app = new App();
    const stack = new Stack(app, 'CustomTimeout', {
      env: { region: 'us-east-1' },
    });
    new BuildPipeline(stack, 'CustomPipeline', {
      timeoutMinutes: 60,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      TimeoutInMinutes: 60,
    });
  });
});

// ── ECR Grants Tests ──────────────────────────────────────────────────────

function createMockEcrClient(
  statements: EcrGrantStatement[] = [],
): EcrClient & {
  _getLog: () => string[];
} {
  const log: string[] = [];
  let current: Record<string, unknown> | null =
    statements.length > 0
      ? (buildRepoPolicyDocument(statements) as unknown as Record<string, unknown>)
      : null;

  return {
    _getLog: () => log,
    async getRepositoryPolicy(): Promise<{ policyText: Record<string, unknown> } | null> {
      log.push('getRepositoryPolicy');
      return current ? { policyText: current } : null;
    },
    async setRepositoryPolicy(
      _repoName: string,
      policyText: Record<string, unknown>,
    ): Promise<void> {
      log.push(`setRepositoryPolicy:${JSON.stringify(policyText)}`);
      current = policyText;
    },
    async deleteRepositoryPolicy(_repoName: string): Promise<void> {
      log.push('deleteRepositoryPolicy');
      current = null;
    },
  };
}

describe('ecr-grants', () => {
  describe('installationGrantSid', () => {
    it('produces a deterministic Sid for an installation', () => {
      expect(installationGrantSid('inst-abc')).toBe('deployz-pull-inst-abc');
    });
  });

  describe('buildPullStatement', () => {
    it('builds a statement with the correct Sid, Effect, and Principal', () => {
      const stmt = buildPullStatement('inst-1', '123456789012');
      expect(stmt.Sid).toBe('deployz-pull-inst-1');
      expect(stmt.Effect).toBe('Allow');
      expect(stmt.Principal.AWS).toBe('arn:aws:iam::123456789012:root');
    });

    it('includes all required ECR pull actions', () => {
      const stmt = buildPullStatement('inst-1', '123456789012');
      expect(stmt.Action.sort()).toEqual([...ECR_PULL_ACTIONS].sort());
    });
  });

  describe('buildRepoPolicyDocument', () => {
    it('returns null for an empty statement list', () => {
      expect(buildRepoPolicyDocument([])).toBeNull();
    });

    it('builds a valid policy document with one statement', () => {
      const stmt = buildPullStatement('inst-1', '123456789012');
      const doc = buildRepoPolicyDocument([stmt]);
      expect(doc).not.toBeNull();
      expect(doc!.Version).toBe('2012-10-17');
      expect(doc!.Statement).toHaveLength(1);
      expect(doc!.Statement[0].Sid).toBe('deployz-pull-inst-1');
    });

    it('builds a policy document with multiple statements', () => {
      const s1 = buildPullStatement('inst-1', '111111111111');
      const s2 = buildPullStatement('inst-2', '222222222222');
      const doc = buildRepoPolicyDocument([s1, s2]);
      expect(doc!.Statement).toHaveLength(2);
    });
  });

  describe('grantPull', () => {
    it('adds a new pull grant when no policy exists', async () => {
      const client = createMockEcrClient();
      const result = await grantPull(client, 'deployz-images', 'inst-1', '123456789012');

      expect(result.added).toBe(true);
      expect(result.statementCount).toBe(1);
      expect(client._getLog()).toEqual([
        'getRepositoryPolicy',
        expect.stringContaining('deployz-pull-inst-1'),
      ]);
    });

    it('adds a second grant alongside an existing one', async () => {
      const existing = buildPullStatement('inst-1', '111111111111');
      const client = createMockEcrClient([existing]);
      const result = await grantPull(client, 'deployz-images', 'inst-2', '222222222222');

      expect(result.added).toBe(true);
      expect(result.statementCount).toBe(2);
    });

    it('replaces an existing grant with the same installation id (idempotent)', async () => {
      const existing = buildPullStatement('inst-1', '111111111111');
      const client = createMockEcrClient([existing]);
      const result = await grantPull(client, 'deployz-images', 'inst-1', '999999999999');

      expect(result.added).toBe(false);
      expect(result.statementCount).toBe(1);
      // The updated statement should have the new account ID
      const log = client._getLog();
      const setLog = log.find((l) => l.startsWith('setRepositoryPolicy:'))!;
      expect(setLog).toContain('999999999999');
    });
  });

  describe('revokePull', () => {
    it('removes a grant and deletes the policy when it was the only statement', async () => {
      const existing = buildPullStatement('inst-1', '123456789012');
      const client = createMockEcrClient([existing]);
      const result = await revokePull(client, 'deployz-images', 'inst-1');

      expect(result.removed).toBe(true);
      expect(result.statementCount).toBe(0);
      expect(result.policyDeleted).toBe(true);
      expect(client._getLog()).toContain('deleteRepositoryPolicy');
    });

    it('removes a grant but retains the policy when other statements exist', async () => {
      const s1 = buildPullStatement('inst-1', '111111111111');
      const s2 = buildPullStatement('inst-2', '222222222222');
      const client = createMockEcrClient([s1, s2]);
      const result = await revokePull(client, 'deployz-images', 'inst-1');

      expect(result.removed).toBe(true);
      expect(result.statementCount).toBe(1);
      expect(result.policyDeleted).toBe(false);
      // Should NOT have called deleteRepositoryPolicy
      expect(client._getLog()).not.toContain('deleteRepositoryPolicy');
    });

    it('is idempotent — revoking a nonexistent grant returns removed: false', async () => {
      const client = createMockEcrClient();
      const result = await revokePull(client, 'deployz-images', 'nonexistent');

      expect(result.removed).toBe(false);
      expect(result.statementCount).toBe(0);
      expect(result.policyDeleted).toBe(false);
    });

    it('is idempotent — revoking from a null policy returns removed: false', async () => {
      const client = createMockEcrClient();
      const result = await revokePull(client, 'deployz-images', 'inst-1');

      expect(result.removed).toBe(false);
      expect(result.statementCount).toBe(0);
      expect(result.policyDeleted).toBe(false);
    });
  });
});

// ── Source Fetch Tests ────────────────────────────────────────────────────

function createMockFetch(
  tarballBytes: Uint8Array = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), // minimal gzip
  status = 200,
  redirectUrl?: string,
): FetchFn {
  const self = {
    async fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string> },
    ): Promise<{
      status: number;
      headers: { get(name: string): string | null };
      arrayBuffer(): Promise<ArrayBuffer>;
      text(): Promise<string>;
    }> {
      // If a redirect URL is configured and this is the API call, return a redirect
      if (redirectUrl && url.includes('api.github.com')) {
        return {
          status: 302,
          headers: {
            get(name: string): string | null {
              return name === 'location' ? redirectUrl : null;
            },
          },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          text: () => Promise.resolve(''),
        };
      }
      return {
        status,
        headers: {
          get(_name: string): string | null {
            return null;
          },
        },
        arrayBuffer: () => Promise.resolve(tarballBytes.buffer),
        text: () => Promise.resolve(''),
      };
    },
  };
  return self.fetch.bind(self);
}

function createMockS3(): S3Client & { _uploads: Array<{ key: string; bytes: number }> } {
  const uploads: Array<{ key: string; bytes: number }> = [];
  return {
    _uploads: uploads,
    async putObject(params: {
      bucket: string;
      key: string;
      body: Uint8Array | string;
      contentType?: string;
    }): Promise<void> {
      const bytes =
        typeof params.body === 'string'
          ? new TextEncoder().encode(params.body).length
          : params.body.length;
      uploads.push({ key: params.key, bytes });
    },
  };
}

const FAKE_TOKEN = 'ghs_test-token';
const REPO_NAME = 'test-org/test-repo';

function makeOptions(overrides?: Partial<FetchRepoArchiveOptions>): FetchRepoArchiveOptions {
  return {
    bucket: 'test-bucket',
    s3KeyPrefix: 'build-source/test-org/test-repo',
    ref: 'main',
    ...overrides,
  };
}

describe('source-fetch', () => {
  describe('fetchRepoArchive', () => {
    it('fetches a repo tarball and uploads it to S3', async () => {
      const tarball = new Uint8Array(1024).fill(0xab);
      const mockFetch = createMockFetch(tarball);
      const mockS3 = createMockS3();

      const result = await fetchRepoArchive(
        FAKE_TOKEN,
        REPO_NAME,
        mockFetch,
        mockS3,
        makeOptions(),
      );

      expect(result.s3Key).toBe('build-source/test-org/test-repo/main.tar.gz');
      expect(result.bytes).toBe(1024);
      expect(result.ref).toBe('main');
      expect(mockS3._uploads).toHaveLength(1);
      expect(mockS3._uploads[0].key).toBe('build-source/test-org/test-repo/main.tar.gz');
      expect(mockS3._uploads[0].bytes).toBe(1024);
    });

    it('follows a 302 redirect from the GitHub API', async () => {
      const tarball = new Uint8Array(512);
      const redirectUrl = 'https://codeload.github.com/test-org/test-repo/legacy.tar.gz/main';
      const mockFetch = createMockFetch(tarball, 200, redirectUrl);
      const mockS3 = createMockS3();

      const result = await fetchRepoArchive(
        FAKE_TOKEN,
        REPO_NAME,
        mockFetch,
        mockS3,
        makeOptions(),
      );

      expect(result.bytes).toBe(512);
      expect(mockS3._uploads).toHaveLength(1);
    });

    it('throws when the GitHub API returns a non-2xx status', async () => {
      const mockFetch = createMockFetch(new Uint8Array(0), 404);
      const mockS3 = createMockS3();

      await expect(
        fetchRepoArchive(FAKE_TOKEN, REPO_NAME, mockFetch, mockS3, makeOptions()),
      ).rejects.toThrow(/Failed to fetch repo tarball/);
    });

    it('throws when the redirect has no Location header', async () => {
      // Pass a redirect status but no redirectUrl — so the API returns 302 without a Location header
      const mockFetch: FetchFn = async (url) => {
        if (url.includes('api.github.com')) {
          return {
            status: 302,
            headers: { get: () => null },
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            text: () => Promise.resolve(''),
          };
        }
        return {
          status: 200,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new Uint8Array(0).buffer),
          text: () => Promise.resolve(''),
        };
      };
      const mockS3 = createMockS3();

      await expect(
        fetchRepoArchive(FAKE_TOKEN, REPO_NAME, mockFetch, mockS3, makeOptions()),
      ).rejects.toThrow(/without a Location header/);
    });

    it('uses a custom ref when provided', async () => {
      const tarball = new Uint8Array(256);
      const mockFetch = createMockFetch(tarball);
      const mockS3 = createMockS3();

      const result = await fetchRepoArchive(
        FAKE_TOKEN,
        REPO_NAME,
        mockFetch,
        mockS3,
        makeOptions({ ref: 'v2.0.0' }),
      );

      expect(result.ref).toBe('v2.0.0');
      expect(result.s3Key).toBe('build-source/test-org/test-repo/v2.0.0.tar.gz');
    });

    it('uploads with the correct content type', async () => {
      const tarball = new Uint8Array(64);
      const mockFetch = createMockFetch(tarball);
      let capturedContentType: string | undefined;
      const mockS3: S3Client & {
        _uploads: Array<{ key: string; contentType?: string }>;
      } = {
        _uploads: [],
        async putObject(params) {
          this._uploads.push({
            key: params.key,
            contentType: params.contentType,
          });
        },
      };

      await fetchRepoArchive(FAKE_TOKEN, REPO_NAME, mockFetch, mockS3, makeOptions());

      expect(mockS3._uploads[0].contentType).toBe('application/gzip');
    });
  });

  describe('needsStreaming', () => {
    it('returns true when content length exceeds the threshold', () => {
      expect(needsStreaming(STREAMING_THRESHOLD_BYTES + 1)).toBe(true);
    });

    it('returns false when content length is below the threshold', () => {
      expect(needsStreaming(STREAMING_THRESHOLD_BYTES - 1)).toBe(false);
    });

    it('returns true when content length is unknown (null)', () => {
      expect(needsStreaming(null)).toBe(true);
    });

    it('returns false when content length exactly equals the threshold', () => {
      expect(needsStreaming(STREAMING_THRESHOLD_BYTES)).toBe(false);
    });
  });
});
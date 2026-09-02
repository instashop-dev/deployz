import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket, type IBucket } from 'aws-cdk-lib/aws-s3';

import { BuildPipeline } from '../src/pipeline/build-pipeline.js';
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
    // CodeBuild reads the repository tarball the control plane uploaded; the
    // source comes from a GitHub App installation token, which CodeBuild
    // cannot hold, so the project has no source of its own.
    const sourceBucket = new Bucket(stack, 'SourceBucket') as IBucket;
    const pipeline = new BuildPipeline(stack, 'BuildPipeline', { sourceBucket });
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
    // Post-build phase should record the image digest, exported so the
    // build's state-change event carries it back to the control plane.
    expect(sourceJson).toContain('IMAGE_DIGEST');
    expect(sourceJson).toContain('exported-variables');
  });

  it('builds with the Dockerfile directory as context, not always the repo root', () => {
    // A Dockerfile that lives in a subdirectory (e.g. `backend/Dockerfile`) is
    // conventionally written to be built with that subdirectory as its
    // context — `COPY requirements.txt .` resolves against `backend/`, not the
    // repo root. Building with a hardcoded `.` context breaks every such app.
    // The buildspec must derive the context from DOCKERFILE_PATH's directory.
    const { template } = synth();
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    expect(project).toBeDefined();
    const sourceJson = JSON.stringify(project!.Properties!['Source']);
    // Context is derived from the Dockerfile's directory, but an explicit
    // BUILD_CONTEXT passed by startBuild (e.g. for `docker/`-convention
    // repos) overrides the dirname fallback.
    expect(sourceJson).toContain('BUILD_CONTEXT=${BUILD_CONTEXT:-$(dirname');
    // The build passes that context to docker, never a bare `.`.
    expect(sourceJson).toContain('-t $ECR_REPOSITORY_URI:$IMAGE_TAG');
    expect(sourceJson).toContain('$BUILD_CONTEXT');
    expect(sourceJson).not.toContain('$ECR_REPOSITORY_URI:$IMAGE_TAG .');
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
      sourceBucket: new Bucket(stack, 'SourceBucket') as IBucket,
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
      sourceBucket: new Bucket(stack, 'SourceBucket') as IBucket,
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
      sourceBucket: new Bucket(stack, 'SourceBucket') as IBucket,
      timeoutMinutes: 60,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      TimeoutInMinutes: 60,
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
/**
 * Build pipeline — CodeBuild project + private ECR repository.
 *
 * The pipeline is CONTROL-PLANE infrastructure (in the Deployz AWS account),
 * NOT customer-account infrastructure. The control plane Lambda fetches the
 * repository source using the GitHub App installation token, uploads it to an
 * S3 bucket, then triggers CodeBuild with the S3 source location.
 *
 * CodeBuild builds the Docker image and pushes it to a private ECR repository.
 * The image is pinned by its immutable `sha256:` digest, written to the
 * `releases.image_digest` column. Customer accounts pull the image via
 * cross-account ECR grants (see ecr-grants.ts).
 *
 * The pipeline is triggered via the `startBuild` API by the control plane
 * (not GitHub webhooks — the source is placed in S3 by the control plane).
 */
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  BuildSpec,
  ComputeType,
  LinuxBuildImage,
  Project,
  type BuildEnvironmentVariable,
} from 'aws-cdk-lib/aws-codebuild';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import type { IRepository } from 'aws-cdk-lib/aws-ecr';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface BuildPipelineProps {
  /** Bucket the control plane uploads repository tarballs to. */
  readonly sourceBucket: IBucket;
  /** ECR repository name (default: `deployz-images`). */
  readonly repositoryName?: string;
  /** CodeBuild compute type (default: SMALL). */
  readonly computeType?: ComputeType;
  /** Build timeout in minutes (default: 30). */
  readonly timeoutMinutes?: number;
  /** ECR repository removal policy (default: RETAIN). */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Build pipeline construct: ECR repository + CodeBuild project.
 *
 * The CodeBuild project builds Docker images from source in S3 and pushes them
 * to the private ECR repository with an immutable `sha256:` digest.
 *
 * Outputs are exported as stack outputs:
 * - `<stackName>-EcrRepositoryUri` — ECR repository URI (no tag)
 * - `<stackName>-CodeBuildProjectArn` — CodeBuild project ARN
 */
export class BuildPipeline extends Construct {
  public readonly repository: IRepository;
  public readonly project: Project;

  constructor(scope: Construct, id: string, props: BuildPipelineProps) {
    super(scope, id);

    const repoName = props.repositoryName ?? 'deployz-images';

    this.repository = new Repository(this, 'Repository', {
      repositoryName: repoName,
      imageTagMutability: TagMutability.IMMUTABLE,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.RETAIN,
    });

    // The ECR repository URI is baked into the buildspec as an environment
    // variable so the build commands can reference it without constructing
    // it from AWS account/region parts.
    const ecrUri = this.repository.repositoryUri;

    this.project = new Project(this, 'BuildProject', {
      environment: {
        buildImage: LinuxBuildImage.STANDARD_7_0,
        computeType: props.computeType ?? ComputeType.SMALL,
        privileged: true, // Required for Docker-in-Docker builds
        environmentVariables: {
          ECR_REPOSITORY_URI: { value: ecrUri },
        } as Record<string, BuildEnvironmentVariable>,
      },
      timeout: Duration.minutes(props.timeoutMinutes ?? 30),
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        // Exported so the build's CodeBuild state-change event carries the
        // digest to the worker, which writes it to releases.image_digest.
        // Reading it out of the build log would be guesswork.
        env: { 'exported-variables': ['IMAGE_DIGEST', 'RELEASE_ID'] },
        phases: {
          pre_build: {
            commands: [
              // The project is NO_SOURCE: the control plane put the
              // repository tarball in S3 (SOURCE_S3_URI, passed via
              // startBuild) because the source comes from a GitHub App
              // installation token, which CodeBuild cannot hold.
              'echo "Fetching source from $SOURCE_S3_URI"',
              'if [ -z "$SOURCE_S3_URI" ]; then echo "ERROR: SOURCE_S3_URI is not set" >&2; exit 1; fi',
              'aws s3 cp "$SOURCE_S3_URI" /tmp/source.tar.gz',
              // GitHub tarballs wrap everything in one `owner-repo-sha`
              // directory; --strip-components=1 unwraps it.
              'mkdir -p /tmp/src && tar xzf /tmp/source.tar.gz -C /tmp/src --strip-components=1',
              'cd /tmp/src',
              'echo "Logging in to Amazon ECR..."',
              'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPOSITORY_URI',
              // §21: image tags must be immutable identifiers — `latest` is
              // the anti-pattern §21 explicitly calls out, and the ECR
              // repository above is IMAGE_TAG_MUTABILITY=IMMUTABLE, so a
              // repeated `latest` push would be hard-rejected by ECR on the
              // second build anyway. Use RELEASE_VERSION (passed via
              // startBuild environmentVariablesOverride) when the control
              // plane supplies one; otherwise fall back to CODEBUILD_BUILD_ID
              // (always set by CodeBuild itself, e.g.
              // "project-name:build-uuid") which is guaranteed unique per
              // build, sanitized for use as a Docker tag.
              'export CODEBUILD_TAG=$(echo "$CODEBUILD_BUILD_ID" | tr ":" "-")',
              'export IMAGE_TAG=${RELEASE_VERSION:-$CODEBUILD_TAG}',
              // Fail fast rather than silently falling back to a mutable tag
              // if neither source produced a usable value.
              'if [ -z "$IMAGE_TAG" ]; then echo "ERROR: no usable image tag - RELEASE_VERSION and CODEBUILD_BUILD_ID are both unset" >&2; exit 1; fi',
            ],
          },
          build: {
            commands: [
              'cd /tmp/src',
              // Analysis records where the Dockerfile actually is; a
              // repository is free to keep it out of the root.
              'export DOCKERFILE_PATH=${DOCKERFILE_PATH:-Dockerfile}',
              // The build context is the Dockerfile's own directory, not the
              // repo root. A Dockerfile kept in a subdirectory (e.g.
              // `backend/Dockerfile`) is written relative to that directory —
              // `COPY requirements.txt .` means `backend/requirements.txt` —
              // exactly as `docker build backend/` would resolve it. Passing a
              // bare `.` (repo root) made every such COPY miss and failed the
              // build. dirname of a root Dockerfile is `.`, so root apps are
              // unaffected. An explicit BUILD_CONTEXT passed via startBuild
              // wins over the fallback: the `docker/` convention (e.g.
              // `docker build -f docker/Dockerfile .`) builds from the repo
              // root, not from `docker/`.
              'export BUILD_CONTEXT=${BUILD_CONTEXT:-$(dirname "$DOCKERFILE_PATH")}',
              'echo "Building Docker image: $ECR_REPOSITORY_URI:$IMAGE_TAG from $DOCKERFILE_PATH (context: $BUILD_CONTEXT)"',
              'docker build -f "$DOCKERFILE_PATH" -t $ECR_REPOSITORY_URI:$IMAGE_TAG "$BUILD_CONTEXT"',
              // Tag with the git SHA for traceability. GIT_SHA is passed via
              // startBuild environmentVariablesOverride.
              'echo "Tagging with GIT_SHA: ${GIT_SHA:-unknown}"',
              'docker tag $ECR_REPOSITORY_URI:$IMAGE_TAG $ECR_REPOSITORY_URI:${GIT_SHA:-unknown}',
            ],
          },
          post_build: {
            commands: [
              'echo "Pushing Docker image to ECR..."',
              'docker push $ECR_REPOSITORY_URI:$IMAGE_TAG',
              'docker push $ECR_REPOSITORY_URI:${GIT_SHA:-unknown}',
              // Extract the immutable sha256 digest. The format string uses
              // double-brace escaping: `{{...}}` is the Go template syntax
              // for docker inspect; CodeBuild does NOT interpret `{{ }}`.
              // The shell receives the literal `{{index .RepoDigests 0}}`.
              'echo "Recording image digest..."',
              'export IMAGE_DIGEST=$(docker inspect --format="{{index .RepoDigests 0}}" $ECR_REPOSITORY_URI:$IMAGE_TAG)',
              'echo "IMAGE_DIGEST=$IMAGE_DIGEST"',
            ],
          },
        },
      }),
    });

    // Grant CodeBuild permission to push images to the ECR repository and
    // to read the source tarball the control plane uploaded.
    this.repository.grantPullPush(this.project);
    props.sourceBucket.grantRead(this.project);

    // ── Stack outputs ──────────────────────────────────────────────────
    const stack = Stack.of(this);
    stack.exportValue(this.repository.repositoryUri, {
      name: `${stack.stackName}-EcrRepositoryUri`,
    });
    stack.exportValue(this.project.projectName, {
      name: `${stack.stackName}-CodeBuildProjectName`,
    });
  }
}
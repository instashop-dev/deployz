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
  type IProject,
} from 'aws-cdk-lib/aws-codebuild';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import type { IRepository } from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface BuildPipelineProps {
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
  public readonly project: IProject;

  constructor(scope: Construct, id: string, props?: BuildPipelineProps) {
    super(scope, id);

    const repoName = props?.repositoryName ?? 'deployz-images';

    this.repository = new Repository(this, 'Repository', {
      repositoryName: repoName,
      imageTagMutability: TagMutability.IMMUTABLE,
      removalPolicy: props?.removalPolicy ?? RemovalPolicy.RETAIN,
    });

    // The ECR repository URI is baked into the buildspec as an environment
    // variable so the build commands can reference it without constructing
    // it from AWS account/region parts.
    const ecrUri = this.repository.repositoryUri;

    this.project = new Project(this, 'BuildProject', {
      environment: {
        buildImage: LinuxBuildImage.STANDARD_7_0,
        computeType: props?.computeType ?? ComputeType.SMALL,
        privileged: true, // Required for Docker-in-Docker builds
        environmentVariables: {
          ECR_REPOSITORY_URI: { value: ecrUri },
        } as Record<string, BuildEnvironmentVariable>,
      },
      timeout: Duration.minutes(props?.timeoutMinutes ?? 30),
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "Logging in to Amazon ECR..."',
              'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPOSITORY_URI',
              // Use the RELEASE_VERSION env var (passed via startBuild
              // environmentVariablesOverride). Fall back to `latest`.
              'export IMAGE_TAG=${RELEASE_VERSION:-latest}',
            ],
          },
          build: {
            commands: [
              'echo "Building Docker image: $ECR_REPOSITORY_URI:$IMAGE_TAG"',
              'docker build -t $ECR_REPOSITORY_URI:$IMAGE_TAG .',
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
              'IMAGE_DIGEST=$(docker inspect --format="{{index .RepoDigests 0}}" $ECR_REPOSITORY_URI:$IMAGE_TAG)',
              'echo "IMAGE_DIGEST=$IMAGE_DIGEST"',
              // Write to a file so the CodeBuild report or log consumer
              // can extract it.
              'echo "$IMAGE_DIGEST" > /tmp/image-digest.txt',
            ],
          },
        },
      }),
    });

    // Grant CodeBuild permission to push images to the ECR repository.
    this.repository.grantPullPush(this.project);

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
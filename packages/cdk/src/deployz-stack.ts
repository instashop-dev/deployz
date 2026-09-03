import { Duration, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import {
  InstanceType,
  InstanceClass,
  InstanceSize,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
  type IVpc,
} from 'aws-cdk-lib/aws-ec2';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { ComputeType } from 'aws-cdk-lib/aws-codebuild';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from 'aws-cdk-lib/aws-rds';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  ObjectOwnership,
  type IBucket,
} from 'aws-cdk-lib/aws-s3';
import { DomainName, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

import { ApiLambda } from './api-lambda.js';
import { BuildPipeline } from './pipeline/build-pipeline.js';
import { WorkerLambda } from './worker-lambda.js';

/**
 * Deployz control-plane stack.
 *
 * Provisions the core infrastructure for the Deployz backend:
 * - VPC with private subnets for RDS
 * - RDS PostgreSQL (db.t4g.micro for MVP; swap to Serverless v2 post-MVP)
 * - Lambda function wrapping the Fastify API (bundled via esbuild)
 * - HTTP API Gateway in front of the Lambda
 * - SQS queue + worker Lambda for async job processing
 * - CodeBuild + ECR release build pipeline, and the public bucket the
 *   customer bootstrap template is published to
 *
 * Region: us-east-1 (hardcoded per plan §32 region allowlist).
 *
 * Credentials are injected by loading the repo-root .env in bin/deployz.ts
 * (dotenv config with explicit path). The env vars are collected here and
 * passed to the Lambda via the `environment` prop.
 */
export class DeployzStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, { ...props, env: { region: 'us-east-1' } });

    Tags.of(this).add('deployz:managed', 'true');
    Tags.of(this).add('deployz:scope', 'control-plane');

    // ── VPC ──────────────────────────────────────────────────────────────
    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: SubnetType.PUBLIC },
        { name: 'Private', subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'Isolated', subnetType: SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // exactOptionalPropertyTypes: Vpc concrete type has wider optional
    // properties than IVpc — cast to satisfy the interface contract.
    const vpcResource = vpc as unknown as IVpc;

    // ── RDS PostgreSQL ───────────────────────────────────────────────────
    const dbSecurityGroup = new SecurityGroup(this, 'DbSecurityGroup', {
      vpc: vpc as unknown as IVpc,
      description: 'RDS PostgreSQL access',
    });

    const dbInstance = new DatabaseInstance(this, 'Database', {
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_16,
      }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      vpc: vpc as unknown as IVpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: Credentials.fromGeneratedSecret('deployz_admin'),
      databaseName: 'deployz',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      backupRetention: Duration.days(7),
      deletionProtection: false,
    });

    // ── SQS (async job processing) ───────────────────────────────────────
    // The dead-letter queue is what makes a poisoned message visible: without
    // one a message that always throws is retried until it silently expires.
    const jobDeadLetterQueue = new Queue(this, 'JobDeadLetterQueue', {
      retentionPeriod: Duration.days(14),
    });
    const jobQueue = new Queue(this, 'JobQueue', {
      // Must be at least the worker's timeout, or SQS re-delivers a message
      // that is still being processed.
      visibilityTimeout: Duration.minutes(15),
      retentionPeriod: Duration.days(14),
      deadLetterQueue: { queue: jobDeadLetterQueue, maxReceiveCount: 3 },
    });

    // ── Release build pipeline (ECR + CodeBuild) ─────────────────────────
    // Repository tarballs land here; CodeBuild reads them (the source comes
    // from a GitHub App installation token, which CodeBuild cannot hold).
    const sourceBucket = new Bucket(this, 'BuildSourceBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });
    const buildPipeline = new BuildPipeline(this, 'BuildPipeline', {
      // exactOptionalPropertyTypes: the concrete Bucket's optional members are
      // narrower than IBucket's, so the interface type has to be asserted.
      sourceBucket: sourceBucket as IBucket,
      // Documenso's monorepo image build exceeds the default SMALL (3 GB)
      // builder and could brush the default 30-minute timeout.
      computeType: ComputeType.LARGE,
      timeoutMinutes: 60,
    });

    // ── Public template bucket ───────────────────────────────────────────
    // CloudFormation in the CUSTOMER's account fetches the bootstrap template
    // and its Lambda assets from here with no credentials of ours, so the
    // objects have to be publicly readable. Nothing secret is ever published:
    // the template's only parameter is the non-secret control-plane URL, and
    // the relay's credential is generated inside the customer's own account.
    const templateBucket = new Bucket(this, 'TemplateBucket', {
      publicReadAccess: true,
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      accessControl: BucketAccessControl.PRIVATE,
      enforceSSL: true,
    });

    // ── API Lambda ───────────────────────────────────────────────────────
    const credentialEnv = collectEnvVars();

    // Set once the publisher has uploaded a template (see
    // `pnpm --filter @deployz/cdk run publish:bootstrap`, which prints the
    // URL). Deliberately not derived from the bucket name: a bucket with no
    // template in it would produce a link that 404s.
    const bootstrapTemplateUrl =
      (this.node.tryGetContext('bootstrapTemplateUrl') as string | undefined) ??
      process.env.BOOTSTRAP_TEMPLATE_URL;

    // Regions whose regional bootstrap artifacts are confirmed published
    // (see @deployz/contracts resolveBootstrapTemplate). Unset → the API
    // fail-closes to us-east-1 only. The publisher prints the exact value.
    const deployableAwsRegions =
      (this.node.tryGetContext('deployableAwsRegions') as string | undefined) ??
      process.env.DEPLOYABLE_AWS_REGIONS;

    // Phase 11 default HTTPS: the Deployz-owned Route53 hosted zone the API
    // writes per-deployment validation/routing CNAMEs into. Hosted out of
    // band (the zone apex must already resolve in production), referenced by
    // id so CDK can scope the API role's route53 grant to exactly that zone.
    const dnsZoneId =
      (this.node.tryGetContext('dnsZoneId') as string | undefined) ??
      process.env.DEPLOYZ_DNS_ZONE_ID;

    const apiLambda = new ApiLambda(this, 'ApiLambda', {
      vpc: vpcResource,
      dbSecurityGroup,
      dbSecretArn: dbInstance.secret?.secretArn ?? '',
      environment: {
        ...credentialEnv,
        JOB_QUEUE_URL: jobQueue.queueUrl,
        // Where the customer's CloudFormation fetches the bootstrap template
        // from. The API builds every install link off this value, so an
        // unpublished template yields no link rather than a broken one.
        ...(bootstrapTemplateUrl ? { BOOTSTRAP_TEMPLATE_URL: bootstrapTemplateUrl } : {}),
        // The API rejects deployment creation in regions whose regional
        // artifacts are not confirmed published (fail closed). The publisher
        // prints this value after verifying every region.
        ...(deployableAwsRegions ? { DEPLOYABLE_AWS_REGIONS: deployableAwsRegions } : {}),
        // Phase 1.1 ECR pull-grant lifecycle: the repository whose policy the
        // API mutates when an installation is granted/revoked.
        DEPLOYZ_ECR_REPOSITORY_NAME: buildPipeline.repository.repositoryName,
        // Phase 11 default HTTPS: the deployz Route53 zone id, when one is
        // configured (absent → the default-HTTPS flow stays off).
        ...(dnsZoneId ? { DEPLOYZ_DNS_ZONE_ID: dnsZoneId } : {}),
      },
    });

    jobQueue.grantSendMessages(apiLambda.function);

    // Phase 1.1: the API rewrites the ECR repository policy to grant/revoke
    // per-installation cross-account pull access. Scoped to this repository,
    // not ecr:* on everything.
    apiLambda.function.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'ecr:GetRepositoryPolicy',
          'ecr:SetRepositoryPolicy',
          'ecr:DeleteRepositoryPolicy',
        ],
        resources: [buildPipeline.repository.repositoryArn],
      }),
    );

    // Phase 11: scoped to the single Deployz-owned hosted zone the API writes
    // CNAME records into — not route53:* on everything. Route53 has no VPC/
    // region concept; the resource ARN is the zone itself.
    if (dnsZoneId) {
      apiLambda.function.addToRolePolicy(
        new PolicyStatement({
          actions: ['route53:ChangeResourceRecordSets'],
          resources: [`arn:aws:route53:::hostedzone/${dnsZoneId}`],
        }),
      );
    }

    dbSecurityGroup.addIngressRule(
      apiLambda.function.connections.securityGroups[0] ?? Peer.anyIpv4(),
      Port.tcp(5432),
      'Allow Lambda to reach RDS',
    );

    // ── Worker Lambda (SQS consumer) ─────────────────────────────────────
    const worker = new WorkerLambda(this, 'Worker', {
      vpc: vpcResource,
      dbSecurityGroup,
      dbSecretArn: dbInstance.secret?.secretArn ?? '',
      queue: jobQueue,
      environment: {
        ...credentialEnv,
        SOURCE_BUCKET: sourceBucket.bucketName,
        BUILD_PROJECT_NAME: buildPipeline.project.projectName,
      },
    });

    sourceBucket.grantPut(worker.function);
    // aws-codebuild has no grant helper for StartBuild/BatchGetBuilds, so the
    // statement is written out — scoped to this project, not codebuild:* on
    // everything. CodeBuild authorizes both actions against the PROJECT
    // resource (BatchGetBuilds included, even though its inputs are build
    // ids — verified live: a `build/<project>:*` scope is AccessDenied).
    worker.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
        resources: [buildPipeline.project.projectArn],
      }),
    );

    // ── HTTP API Gateway ─────────────────────────────────────────────────
    //
    // The custom domain is optional so that a plain `cdk deploy` (and every
    // synth in the test suite) still works without one. Supply both values to
    // turn it on, via `cdk deploy -c apiDomainName=... -c apiCertificateArn=...`
    // or via the repo-root .env that bin/deployz.ts already loads.
    //
    // The certificate is deliberately NOT created here. DNS lives on
    // Cloudflare, so a CDK-managed DNS-validated certificate would need a
    // Route 53 zone that does not exist, and CloudFormation would sit blocked
    // for the validation timeout waiting on a record only a human can add.
    // Request it out of band (`aws acm request-certificate`), let it reach
    // ISSUED, then pass the ARN in — the same shape ApplicationStack already
    // uses for customer certificates.
    const apiDomainName =
      (this.node.tryGetContext('apiDomainName') as string | undefined) ??
      process.env.API_DOMAIN_NAME;
    const apiCertificateArn =
      (this.node.tryGetContext('apiCertificateArn') as string | undefined) ??
      process.env.API_CERTIFICATE_ARN;

    const apiDomain =
      apiDomainName && apiCertificateArn
        ? new DomainName(this, 'ApiDomain', {
            domainName: apiDomainName,
            certificate: Certificate.fromCertificateArn(
              this,
              'ApiCertificate',
              apiCertificateArn,
            ),
          })
        : undefined;

    const httpApi = new HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', apiLambda.function),
      ...(apiDomain ? { defaultDomainMapping: { domainName: apiDomain } } : {}),
    });

    // A finished build is the only way a release learns its image digest —
    // CodeBuild reports completion here, and the worker writes the digest to
    // releases.image_digest.
    new Rule(this, 'BuildStateRule', {
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: {
          'project-name': [buildPipeline.project.projectName],
          'build-status': ['SUCCEEDED', 'FAILED', 'STOPPED', 'FAULT', 'TIMED_OUT'],
        },
      },
      targets: [new LambdaFunction(worker.function)],
    });

    // ── Stack outputs ────────────────────────────────────────────────────
    this.exportValue(dbInstance.instanceEndpoint.hostname, {
      name: `${this.stackName}-DbHost`,
    });
    this.exportValue(dbInstance.secret?.secretArn ?? '', {
      name: `${this.stackName}-DbSecretArn`,
    });
    this.exportValue(apiLambda.function.functionArn, {
      name: `${this.stackName}-ApiFunctionArn`,
    });
    this.exportValue(httpApi.apiEndpoint, {
      name: `${this.stackName}-ApiUrl`,
    });
    this.exportValue(jobQueue.queueArn, {
      name: `${this.stackName}-JobQueueArn`,
    });
    this.exportValue(templateBucket.bucketName, {
      name: `${this.stackName}-TemplateBucket`,
    });
    this.exportValue(sourceBucket.bucketName, {
      name: `${this.stackName}-BuildSourceBucket`,
    });

    if (apiDomain) {
      // This is the value that goes into Cloudflare: an `api` CNAME pointing
      // here, DNS-only (grey cloud). Proxying it would break TLS — Cloudflare
      // sends the origin hostname as SNI, API Gateway answers with the
      // certificate for the custom domain, and the mismatch surfaces as a 525.
      this.exportValue(apiDomain.regionalDomainName, {
        name: `${this.stackName}-ApiRegionalDomainName`,
      });
      this.exportValue(apiDomain.regionalHostedZoneId, {
        name: `${this.stackName}-ApiRegionalHostedZoneId`,
      });
    }
  }
}

/**
 * Collect credential env vars from process.env. The .env file is loaded by
 * bin/deployz.ts before the CDK app runs, so these are available here.
 * Only the vars that are actually set are included.
 *
 * Two things follow from "only the vars that are actually set":
 *  - A key missing from .env is REMOVED from the deployed function, not left
 *    at its previous value. Every key the API needs in production has to be
 *    present in the environment the deploy runs from.
 *  - GITHUB_FIXTURE_MODE is deliberately NOT here. It makes the GitHub routes
 *    serve the fixture org and repos, which is right for local dev and the
 *    e2e run (playwright.config.ts sets it for the API it starts) and is
 *    never right for a real tenant. Keeping it out of the allowlist means a
 *    developer's .env cannot ship it to production by accident.
 */
function collectEnvVars(): Record<string, string> {
  const keys = [
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_URL',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_BASE',
    'STRIPE_PRICE_METERED',
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_APP_INSTALL_URL',
    'EMAIL_FROM',
    'API_URL',
    'WEB_URL',
    'MARKETING_URL',
    'COOKIE_DOMAIN',
    'AI_GATEWAY_BASE_URL',
    'AI_MODEL',
    'AI_PROVIDER_API_KEY',
    'AI_GATEWAY_TOKEN',
    'AWS_SES_ACCESS_KEY_ID',
    'AWS_SES_SECRET_ACCESS_KEY',
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      env[key] = value;
    }
  }
  return env;
}

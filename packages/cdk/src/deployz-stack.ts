import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
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
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from 'aws-cdk-lib/aws-rds';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { DomainName, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

import { ApiLambda } from './api-lambda.js';
import { DurableExecution } from './durable/durable-stack.js';

/**
 * Deployz control-plane stack.
 *
 * Provisions the core infrastructure for the Deployz backend:
 * - VPC with private subnets for RDS
 * - RDS PostgreSQL (db.t4g.micro for MVP; swap to Serverless v2 post-MVP)
 * - Lambda function wrapping the Fastify API (bundled via esbuild)
 * - HTTP API Gateway in front of the Lambda
 * - EventBridge rule + SQS queue for async job processing
 * - DynamoDB-backed durable execution framework (U1 spike)
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

    // ── EventBridge + SQS (async job processing) ─────────────────────────
    const jobQueue = new Queue(this, 'JobQueue', {
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(14),
    });

    // ── API Lambda ───────────────────────────────────────────────────────
    const credentialEnv = collectEnvVars();

    const apiLambda = new ApiLambda(this, 'ApiLambda', {
      vpc: vpcResource,
      dbSecurityGroup,
      dbSecretArn: dbInstance.secret?.secretArn ?? '',
      environment: {
        ...credentialEnv,
        JOB_QUEUE_URL: jobQueue.queueUrl,
      },
    });

    jobQueue.grantSendMessages(apiLambda.function);

    dbSecurityGroup.addIngressRule(
      apiLambda.function.connections.securityGroups[0] ?? Peer.anyIpv4(),
      Port.tcp(5432),
      'Allow Lambda to reach RDS',
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

    // EventBridge rule: forward deployment_job events to SQS.
    // The actual event pattern is wired by the application at deploy time;
    // here we create the plumbing.
    new Rule(this, 'JobEventRule', {
      eventPattern: {
        source: ['deployz.jobs'],
        detailType: ['JobStateChange'],
      },
      targets: [new SqsQueue(jobQueue)],
    });

    // ── Durable Execution (U1 spike) ─────────────────────────────────────
    const durable = new DurableExecution(this, 'DurableExecution', {
      vpc: vpcResource,
      httpApi,
      ...(apiDomainName ? { publicBaseUrl: `https://${apiDomainName}` } : {}),
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
    this.exportValue(durable.callbackUrl, {
      name: `${this.stackName}-DurableCallbackUrl`,
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
    'GITHUB_FIXTURE_MODE',
    'API_URL',
    'WEB_URL',
    'MARKETING_URL',
    'COOKIE_DOMAIN',
    'CLOUDFLARE_AI_GATEWAY_ENDPOINT',
    'CLOUDFLARE_AI_GATEWAY_API_TOKEN',
    'AWS_SES_ACCESS_KEY_ID',
    'AWS_SES_SECRET_ACCESS_KEY',
    'EMAIL_FROM',
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

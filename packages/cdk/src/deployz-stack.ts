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

    // ── API Lambda ───────────────────────────────────────────────────────
    const apiLambda = new ApiLambda(this, 'ApiLambda', {
      vpc: vpcResource,
      dbSecurityGroup,
      database: dbInstance,
    });

    dbSecurityGroup.addIngressRule(
      apiLambda.function.connections.securityGroups[0] ?? Peer.anyIpv4(),
      Port.tcp(5432),
      'Allow Lambda to reach RDS',
    );

    // ── EventBridge + SQS (async job processing) ─────────────────────────
    const jobQueue = new Queue(this, 'JobQueue', {
      visibilityTimeout: Duration.minutes(5),
      retentionPeriod: Duration.days(14),
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
    this.exportValue(jobQueue.queueArn, {
      name: `${this.stackName}-JobQueueArn`,
    });
    this.exportValue(durable.callbackUrl, {
      name: `${this.stackName}-DurableCallbackUrl`,
    });
  }
}
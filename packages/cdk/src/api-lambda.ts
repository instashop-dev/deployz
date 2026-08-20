import { Duration } from 'aws-cdk-lib';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { IDatabaseInstance } from 'aws-cdk-lib/aws-rds';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface ApiLambdaProps {
  readonly vpc: IVpc;
  readonly dbSecurityGroup: ISecurityGroup;
  readonly database: IDatabaseInstance;
}

/**
 * Lambda function wrapping the Fastify API.
 *
 * Uses esbuild (NodejsFunction) to bundle apps/api into a single Lambda
 * handler. The handler lives in src/lambda/api-handler.ts and imports
 * @deployz/api's buildServer to create the Fastify instance.
 *
 * The Lambda runs inside the VPC so it can reach RDS; the security group
 * on the Lambda is granted ingress to the DB security group by the caller.
 */
export class ApiLambda extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiLambdaProps) {
    super(scope, id);

    this.function = new NodejsFunction(this, 'Function', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(import.meta.dirname, '..', 'src', 'lambda', 'api-handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 512,
      logRetention: RetentionDays.ONE_WEEK,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.dbSecurityGroup],
      environment: {
        DATABASE_URL: `postgres://deployz_admin:CHANGE_ME@${props.database.instanceEndpoint.hostname}:${props.database.instanceEndpoint.port}/deployz`,
        NODE_ENV: 'production',
      },
      bundling: {
        externalModules: [
          '@electric-sql/pglite',
          '@deployz/api',
          '@deployz/db',
          '@deployz/contracts',
        ],
        format: 'esm' as OutputFormat,
        target: 'node22',
        sourceMap: true,
      },
    });

    // Grant Lambda access to the DB secret in Secrets Manager.
    // The secret is on the concrete DatabaseInstance, not IDatabaseInstance.
    // We access it via escape hatch if available.
    const dbNode = props.database.node.defaultChild;
    if (dbNode && 'secret' in dbNode) {
      const secret = (dbNode as { secret?: { grantRead: (fn: NodejsFunction) => void } }).secret;
      secret?.grantRead(this.function);
    }
  }
}
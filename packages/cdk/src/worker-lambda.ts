import { Duration } from 'aws-cdk-lib';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface WorkerLambdaProps {
  readonly vpc: IVpc;
  readonly dbSecurityGroup: ISecurityGroup;
  /** ARN of the RDS master secret in Secrets Manager. */
  readonly dbSecretArn: string;
  /** The job queue this worker consumes. */
  readonly queue: IQueue;
  /** Extra environment variables (credentials + resource names). */
  readonly environment?: Record<string, string>;
}

/**
 * Worker Lambda — the SQS consumer for control-plane background work.
 *
 * The API Lambda cannot do this work itself. Lambda freezes an execution
 * environment as soon as the response is sent, so work detached after a reply
 * never finishes; a repository analysis or a release build needs an
 * invocation of its own. Fifteen minutes is Lambda's maximum and matches the
 * queue's visibility timeout.
 *
 * `reportBatchItemFailures` makes the handler's per-message result meaningful:
 * only the messages it names are retried, instead of the whole batch.
 */
export class WorkerLambda extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: WorkerLambdaProps) {
    super(scope, id);

    this.function = new NodejsFunction(this, 'Function', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(import.meta.dirname, '..', 'src', 'lambda', 'worker-handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 1024,
      logRetention: RetentionDays.ONE_WEEK,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.dbSecurityGroup],
      environment: {
        DB_SECRET_ARN: props.dbSecretArn,
        NODE_ENV: 'production',
        ...props.environment,
      },
      bundling: {
        // pg uses dynamic require(); CJS bundling avoids ESM loader errors.
        externalModules: ['@electric-sql/pglite'],
        format: OutputFormat.CJS,
        target: 'node22',
        sourceMap: true,
        // Bundle drizzle .sql migrations as text strings at build time.
        loader: { '.sql': 'text' },
      },
    });

    this.function.addEventSource(
      new SqsEventSource(props.queue, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );

    const dbSecret = Secret.fromSecretCompleteArn(this, 'DbSecret', props.dbSecretArn);
    dbSecret.grantRead(this.function);
  }
}

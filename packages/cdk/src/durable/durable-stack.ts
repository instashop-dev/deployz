/**
 * U1 Durable Function spike — CDK constructs.
 *
 * Provisions the infrastructure for durable execution on Lambda:
 * - DynamoDB table for workflow state persistence
 * - Lambda function for step execution + callback handling
 * - HTTP API route for external callback resumption
 *
 * This is the INFRASTRUCTURE half of the U1 spike. The RUNTIME half
 * (durable-runtime.ts + durable-handler.ts) implements the pattern.
 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { IVpc } from 'aws-cdk-lib/aws-ec2';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface DurableExecutionProps {
  readonly vpc: IVpc;
}

/**
 * Durable execution infrastructure.
 *
 * Exposes `callbackUrl` — the public endpoint that external callers
 * (the relay Lambda in the customer's account) POST to in order to
 * resume a suspended workflow.
 */
export class DurableExecution extends Construct {
  public readonly table: Table;
  public readonly function: NodejsFunction;
  public readonly callbackUrl: string;

  constructor(scope: Construct, id: string, props: DurableExecutionProps) {
    super(scope, id);

    // ── DynamoDB: workflow state ───────────────────────────────────────
    this.table = new Table(this, 'WorkflowState', {
      partitionKey: { name: 'executionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // MVP: allow teardown
      timeToLiveAttribute: 'ttl', // Auto-expire old workflows
    });

    // ── Lambda: step execution + callback handling ─────────────────────
    this.function = new NodejsFunction(this, 'Function', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(import.meta.dirname, '..', '..', 'src', 'durable', 'durable-handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5), // Generous: steps may be slow
      memorySize: 256,
      logRetention: RetentionDays.ONE_WEEK,
      vpc: props.vpc,
      environment: {
        WORKFLOW_TABLE: this.table.tableName,
      },
      bundling: {
        format: 'esm' as OutputFormat,
        target: 'node22',
        sourceMap: true,
      },
    });

    this.table.grantReadWriteData(this.function);

    // ── Callback URL (documented, not created here) ────────────────────
    // In production, an HTTP API route is attached to this Lambda.
    // For the spike, the callback URL pattern is:
    //   POST https://api.deployz.dev/durable/{workflowName}/{executionId}/callback
    // The handler routes API Gateway events to handleCallback().
    this.callbackUrl =
      'https://api.deployz.dev/durable/{workflowName}/{executionId}/callback';
  }
}
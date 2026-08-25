import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

// Control-plane work queue (SQS, JOB_QUEUE_URL injected by CDK).
//
// Anything that outlives a single HTTP request goes here. The API runs as a
// Lambda: the execution environment is FROZEN the moment the response is
// sent, so work started with `void doSomething()` after a reply simply stops
// mid-promise and never resumes. A queued message is picked up by the worker
// Lambda (packages/cdk/src/lambda/worker-handler.ts), which has its own
// invocation and its own timeout.
//
// Without JOB_QUEUE_URL (local dev, tests) `enqueue` reports false and the
// caller runs the work inline — correct there, because a long-lived Fastify
// process is not frozen after a response.

/** Every message shape the worker understands. */
export type QueueMessage =
  | { readonly type: 'ANALYSE_APPLICATION'; readonly applicationId: string }
  | { readonly type: 'BUILD_RELEASE'; readonly releaseId: string }
  | {
      readonly type: 'CONFIG_UPDATE';
      readonly customerId: string;
      readonly entries: readonly { key: string; value: string; isSecret: boolean }[];
    };

let client: SQSClient | undefined;

function getClient(): SQSClient {
  if (!client) {
    client = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  }
  return client;
}

/**
 * Enqueue one message. Returns false when no queue is configured, which is
 * the caller's signal to do the work inline instead.
 */
export async function enqueue(message: QueueMessage): Promise<boolean> {
  const queueUrl = process.env.JOB_QUEUE_URL;
  if (!queueUrl) return false;

  await getClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
    }),
  );
  return true;
}

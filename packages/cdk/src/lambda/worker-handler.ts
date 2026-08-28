/**
 * Worker Lambda entry point.
 *
 * Wires the real AWS, GitHub and database seams into the worker (worker.ts)
 * and adapts the two event sources it is subscribed to: the SQS job queue,
 * and the CodeBuild state-change rule that reports a finished release build.
 *
 * Queue failures are reported per message (`batchItemFailures`) so one bad
 * message never re-drives a whole batch.
 */
import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { PutObjectCommand, S3Client as SdkS3Client } from '@aws-sdk/client-s3';

import { createAnalysisRunner } from '@deployz/api/analysis';
import type { QueueMessage } from '@deployz/api/queue';

import { connectDb, type LambdaDb } from './db-connection.js';
import {
  handleMessage,
  recordBuildResult,
  type CodeBuildStateChangeEvent,
  type RepositoryFetch,
  type S3Client,
  type WorkerDeps,
} from './worker.js';

interface SqsEvent {
  readonly Records: readonly { readonly messageId: string; readonly body: string }[];
}

type WorkerEvent = SqsEvent | CodeBuildStateChangeEvent;

interface BatchResponse {
  readonly batchItemFailures: { readonly itemIdentifier: string }[];
}

const fetchFn: RepositoryFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(init?.body ? { body: init.body } : {}),
  });
  return {
    status: response.status,
    headers: { get: (name: string) => response.headers.get(name) },
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer(),
    text: () => response.text(),
  };
};

let s3: SdkS3Client | undefined;
let codeBuild: CodeBuildClient | undefined;

const s3Client: S3Client = {
  async putObject(params) {
    s3 ??= new SdkS3Client({});
    await s3.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ...(params.contentType ? { ContentType: params.contentType } : {}),
      }),
    );
  },
};

/** Wires the real AWS, GitHub and database seams. */
function createDeps(db: LambdaDb): WorkerDeps {
  return {
    db,
    fetchFn,
    s3: s3Client,
    async startBuild(input) {
      codeBuild ??= new CodeBuildClient({});
      const response = await codeBuild.send(
        new StartBuildCommand({
          projectName: input.projectName,
          environmentVariablesOverride: input.environmentVariables.map((variable) => ({
            ...variable,
            type: 'PLAINTEXT',
          })),
        }),
      );
      return response.build?.id ?? null;
    },
    runAnalysis: createAnalysisRunner({
      db,
      fetchFn,
      githubAppId: process.env.GITHUB_APP_ID,
      githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      githubFixtureMode: process.env.GITHUB_FIXTURE_MODE === 'true',
    }),
  };
}

function isSqsEvent(event: WorkerEvent): event is SqsEvent {
  return Array.isArray((event as SqsEvent).Records);
}

export async function handler(event: WorkerEvent): Promise<BatchResponse | void> {
  const db = await connectDb();

  if (!isSqsEvent(event)) {
    if (event['detail-type'] === 'CodeBuild Build State Change') {
      await recordBuildResult(db, event);
    }
    return;
  }

  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await handleMessage(createDeps(db), JSON.parse(record.body) as QueueMessage, record.messageId);
    } catch (error) {
      console.error(`worker message ${record.messageId} failed`, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

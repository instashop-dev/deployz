/**
 * U1 Durable Function spike — Lambda handler.
 *
 * This handler is the entry point for the durable execution Lambda.
 * It handles two event types:
 * 1. API Gateway HTTP events — external callback resumption
 * 2. Direct invocation — step execution (triggered by EventBridge or SQS)
 *
 * In production, the workflow registry maps workflow names to generator
 * functions. For the spike, we hardcode a single demo workflow.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

import {
  DurableRuntime,
  InMemoryStateStore,
  step,
  wait,
  waitForCallback,
  type DurableWorkflow,
  type StateStore,
  type WorkflowState,
} from './durable-runtime.js';

// ── Demo workflow (U1 spike proof) ───────────────────────────────────────

interface InstallInput {
  deploymentId: string;
  customerId: string;
  region: string;
}

interface InstallOutput {
  status: string;
  installToken: string;
  confirmedBy: string;
}

/**
 * Demo INSTALL workflow with 3 steps + waitForCallback + wait.
 *
 * Step 1: Validate input
 * Step 2: Wait for customer to click the install link (external callback)
 * Step 3: Provision infrastructure (simulated)
 * Step 4: Wait 1 second (simulated cooldown)
 * Step 5: Confirm installation
 */
async function* installWorkflow(
  input: InstallInput,
): AsyncGenerator<
  ReturnType<typeof step> | ReturnType<typeof waitForCallback> | ReturnType<typeof wait>,
  InstallOutput,
  unknown
> {
  // Step 1: Validate
  yield step('validate-input', async () => {
    if (!input.deploymentId || !input.customerId) {
      throw new Error('Missing required fields');
    }
    return { valid: true, region: input.region };
  });

  // Step 2: Wait for customer approval (external callback)
  // The callback token is the deployment's installationId — when the
  // customer clicks the install link, the relay calls back with this token.
  const callbackData = yield waitForCallback(`install-${input.deploymentId}`);

  // Step 3: Provision (simulated)
  yield step('provision-infra', async () => {
    // In production: create CloudFormation stack, ECS service, etc.
    return { stackId: `cfn-${input.deploymentId}`, status: 'CREATE_COMPLETE' };
  });

  // Step 4: Cooldown
  yield wait(1000);

  // Step 5: Confirm
  yield step('confirm-install', async () => {
    return { confirmed: true, at: new Date().toISOString() };
  });

  return {
    status: 'INSTALLED',
    installToken: `install-${input.deploymentId}`,
    confirmedBy: String((callbackData as Record<string, unknown> | undefined)?.['confirmedBy'] ?? 'system'),
  };
}

// ── Workflow registry ────────────────────────────────────────────────────

const workflows: Record<string, DurableWorkflow> = {
  install: installWorkflow as DurableWorkflow,
};

// ── State store ──────────────────────────────────────────────────────────

// In production this is DynamoDB-backed. For the spike, in-memory works
// because we're proving the PATTERN, not the persistence layer.
const store: StateStore = new InMemoryStateStore();
const runtime = new DurableRuntime(store);

// ── Handler ──────────────────────────────────────────────────────────────

/**
 * Main handler. Routes based on event source:
 * - API Gateway (HTTP) → callback resumption
 * - Direct invocation → step execution
 */
export async function handler(
  event: APIGatewayProxyEventV2 | DurableInvokeEvent,
): Promise<APIGatewayProxyResultV2 | WorkflowState> {
  // API Gateway event: external callback resumption
  if (isApiGatewayEvent(event)) {
    return handleCallback(event);
  }

  // Direct invocation: step execution
  return handleInvoke(event);
}

// ── Event type guards ────────────────────────────────────────────────────

interface DurableInvokeEvent {
  action: 'start' | 'resume';
  workflowName: string;
  executionId: string;
  input?: unknown;
  callbackData?: unknown;
}

function isApiGatewayEvent(
  event: APIGatewayProxyEventV2 | DurableInvokeEvent,
): event is APIGatewayProxyEventV2 {
  return 'requestContext' in event && 'http' in (event as APIGatewayProxyEventV2).requestContext;
}

// ── Callback handler (API Gateway) ───────────────────────────────────────

async function handleCallback(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const executionId = event.pathParameters?.['executionId'];
  const workflowName = event.pathParameters?.['workflowName'];

  if (!executionId || !workflowName) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing executionId or workflowName' }),
    };
  }

  const workflow = workflows[workflowName];
  if (!workflow) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: `Unknown workflow: ${workflowName}` }),
    };
  }

  let callbackData: unknown = undefined;
  if (event.body) {
    try {
      callbackData = JSON.parse(event.body);
    } catch {
      // Body is not JSON — pass as-is
      callbackData = event.body;
    }
  }

  try {
    const state = await runtime.resume(workflow, executionId, callbackData);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}

// ── Direct invocation handler ────────────────────────────────────────────

async function handleInvoke(
  event: DurableInvokeEvent,
): Promise<WorkflowState> {
  const workflow = workflows[event.workflowName];
  if (!workflow) {
    throw new Error(`Unknown workflow: ${event.workflowName}`);
  }

  if (event.action === 'start') {
    return runtime.start(workflow, event.input, event.executionId);
  }

  if (event.action === 'resume') {
    return runtime.resume(workflow, event.executionId, event.callbackData);
  }

  throw new Error(`Unknown action: ${event.action}`);
}
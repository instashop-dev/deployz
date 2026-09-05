import { describe, expect, it } from 'vitest';

import { MAX_RELEVANT_EVENTS, buildFailureContext, toStructuredEvent } from './failure-context.js';

// AI MVP Phase 6 — the bounded, sanitised failure context: what the
// diagnostics response shows and what the AI explainer receives. Built from
// the failed job and its CloudFormation events only; every free-text field
// is redacted and truncated here.

const base = {
  deploymentId: 'dep-1',
  attempt: 2,
  applicationVersion: 'v1.4.0',
  stackEvents: [
    { logicalResourceId: 'Vpc', resourceType: 'AWS::EC2::VPC', resourceStatus: 'CREATE_COMPLETE', resourceStatusReason: null },
    {
      logicalResourceId: 'Database',
      resourceType: 'AWS::RDS::DBInstance',
      resourceStatus: 'CREATE_FAILED',
      resourceStatusReason: 'Cannot create more than 40 DB instances PASSWORD=hunter2',
    },
    {
      logicalResourceId: 'Service',
      resourceType: 'AWS::ECS::Service',
      resourceStatus: 'CREATE_FAILED',
      resourceStatusReason: 'Resource creation cancelled',
    },
    { logicalResourceId: 'Stack', resourceType: 'AWS::CloudFormation::Stack', resourceStatus: 'ROLLBACK_COMPLETE', resourceStatusReason: null },
  ],
};

describe('buildFailureContext', () => {
  it('names the phase, the settled code, the blamed resource and the failed events, redacted and bounded', () => {
    const context = buildFailureContext({
      ...base,
      job: {
        type: 'INSTALL',
        failureCode: 'QUOTA_EXCEEDED',
        result: {
          success: false,
          failureCode: 'STACK_CREATE_FAILED',
          error: 'Stack failed: token=ghp_abcdefghijklmnopqrstuvwxyz1234567890 quota exceeded',
        },
      },
    });
    expect(context).toMatchObject({
      deploymentId: 'dep-1',
      phase: 'INSTALL',
      attempt: 2,
      failureCode: 'QUOTA_EXCEEDED',
      reportedFailureCode: 'STACK_CREATE_FAILED',
      resourceType: 'AWS::RDS::DBInstance',
      applicationVersion: 'v1.4.0',
    });
    expect(context.message).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(context.message).not.toContain('ghp_abc');
    // Cancellation noise and the stack's own status never count as a cause.
    expect(context.relevantEvents).toEqual([
      {
        logicalResourceId: 'Database',
        resourceType: 'AWS::RDS::DBInstance',
        resourceStatus: 'CREATE_FAILED',
        reason: 'Cannot create more than 40 DB instances PASSWORD=[REDACTED]',
      },
    ]);
  });

  it('reports the relay code only when refinement changed it, and UNKNOWN when the job carries none', () => {
    const same = buildFailureContext({
      ...base,
      job: { type: 'DEPLOY_RELEASE', failureCode: 'ECS_DEPLOYMENT_FAILED', result: { failureCode: 'ECS_DEPLOYMENT_FAILED' } },
    });
    expect(same.reportedFailureCode).toBeNull();
    const none = buildFailureContext({ ...base, job: { type: 'INSTALL', failureCode: null, result: null }, stackEvents: [] });
    expect(none).toMatchObject({ failureCode: 'UNKNOWN', reportedFailureCode: null, resourceType: null, message: null, relevantEvents: [] });
  });

  it('keeps at most MAX_RELEVANT_EVENTS failed events and truncates long reasons', () => {
    const events = Array.from({ length: MAX_RELEVANT_EVENTS + 3 }, (_, index) => ({
      logicalResourceId: `Res${index}`,
      resourceType: 'AWS::ECS::Service',
      resourceStatus: 'CREATE_FAILED',
      resourceStatusReason: 'x'.repeat(1000),
    }));
    const context = buildFailureContext({ ...base, stackEvents: events, job: { type: 'INSTALL', failureCode: 'CONTAINER_START_FAILED', result: {} } });
    expect(context.relevantEvents).toHaveLength(MAX_RELEVANT_EVENTS);
    expect(context.relevantEvents[0]?.reason?.length).toBeLessThanOrEqual(320);
    expect(context.relevantEvents[0]?.reason).toContain('[truncated]');
  });
});

describe('toStructuredEvent', () => {
  it('carries only sanitised, bounded fields into the AI event', () => {
    const context = buildFailureContext({
      ...base,
      job: { type: 'INSTALL', failureCode: 'UNKNOWN', result: { error: 'Authorization: Bearer abc.def.ghi failed' } },
    });
    const event = toStructuredEvent(context, 'FAILED');
    expect(event).toEqual({
      source: 'deployment',
      action: 'INSTALL',
      error: { message: 'Authorization: [REDACTED] failed' },
      context: {
        deploymentState: 'FAILED',
        attempt: 2,
        resourceType: 'AWS::RDS::DBInstance',
        failedResources: ['AWS::RDS::DBInstance CREATE_FAILED: Cannot create more than 40 DB instances PASSWORD=[REDACTED]'],
        applicationVersion: 'v1.4.0',
      },
    });
  });
});

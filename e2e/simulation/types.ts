/**
 * Scenario types for the simulated-infrastructure E2E harness.
 *
 * A scenario is a deterministic CloudFormation event timeline plus a handful
 * of AWS-shaped knobs (final stack status, ECS/target-health behaviour) that
 * the simulated customer account (`./simulated-account.ts`) plays back to the
 * REAL relay code (`packages/relay`). See
 * docs/testing/discovery/phase1-design-decisions.md D4 for the two-clock
 * design this timeline shape exists to support.
 *
 * Only four scenarios are implemented today (happy-path,
 * cloudformation-rollback, ecs-failure, healthcheck-failure — see
 * ./scenarios/index.ts), but every field here is shaped for the full Phase 1
 * list so later scenarios never need this file reshaped.
 */

/** One CloudFormation stack event in the scenario's timeline. */
export interface TimelineEvent {
  /**
   * Real (wall-clock) milliseconds after install start at which this event
   * becomes visible to the simulated account's readers. 50–500ms scale —
   * this is what keeps the whole suite fast.
   */
  readonly afterMs: number;
  /**
   * Simulated milliseconds elapsed "into the install" this event's
   * `Timestamp` field should report — minutes scale (e.g. 300_000 for "5
   * minutes in"). Anchored to a real instant by the simulated account so the
   * reported `Timestamp` is always plausible and never in the future
   * relative to the API's own clock (see `anchorVirtualMs` in
   * simulated-account.ts).
   */
  readonly atVirtualMs: number;
  /**
   * The stack's own name for a stack-level event (`resourceType` ===
   * `AWS::CloudFormation::Stack`) — the actual value is substituted at
   * reveal time with whatever name `CreateStack` was called with, so a
   * placeholder such as `'__stack__'` is fine here.
   */
  readonly logicalResourceId: string;
  /** Real AWS CloudFormation resource type, e.g. `AWS::RDS::DBInstance`. */
  readonly resourceType: string;
  /** CloudFormation `ResourceStatus`, e.g. `CREATE_IN_PROGRESS`. */
  readonly status: string;
  /** CloudFormation's `ResourceStatusReason`, when this event carries one. */
  readonly statusReason?: string;
}

/** Scenario-controlled ECS/ELB runtime-health behaviour (`ecs-health.ts`). */
export type EcsRolloutBehavior =
  | {
      readonly kind: 'healthy';
      readonly desiredCount: number;
      readonly runningCount: number;
    }
  | {
      /** `DescribeServices` reports a `FAILED` rollout — the ECS deployment
       *  circuit breaker tripped. */
      readonly kind: 'rollout-failed';
      readonly desiredCount: number;
      readonly runningCount: number;
    }
  | {
      /** The service is running, but the load balancer's target health
       *  check is failing some or all targets. */
      readonly kind: 'unhealthy-targets';
      readonly desiredCount: number;
      readonly runningCount: number;
      readonly targetCount: number;
      readonly unhealthyTargetCount: number;
    };

export interface ScenarioDefinition {
  readonly id: string;
  readonly description: string;
  /**
   * Ordered oldest-first (by `afterMs`/`atVirtualMs`) CloudFormation event
   * timeline, resource events only — the stack's own terminal status is
   * `finalStackStatus`, not a timeline entry, though intermediate stack-level
   * transitions (e.g. `ROLLBACK_IN_PROGRESS`) may appear in the timeline.
   */
  readonly timeline: readonly TimelineEvent[];
  /**
   * The stack's status once every timeline event has been revealed —
   * `DescribeStacks`' `StackStatus` from that point on.
   */
  readonly finalStackStatus: string;
  /** `DescribeStacks`' `Outputs`, reported only once `finalStackStatus` is a
   *  successful terminal state (`CREATE_COMPLETE`/`UPDATE_COMPLETE`). */
  readonly outputs?: Readonly<Record<string, string>>;
  /** Whether the installation should include an ElastiCache cluster —
   *  drives `verifyInstallation`'s cache check and template selection. */
  readonly redisRequired?: boolean;
  /** ECS/target-health behaviour observed by `ecs-health.ts`'s heartbeat
   *  probe, once the ECS service + target group resources are complete. */
  readonly ecsBehavior?: EcsRolloutBehavior;
}

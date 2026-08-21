/**
 * CONFIG_UPDATE workflow — the durable function that writes application
 * configuration to a HEALTHY deployment via the relay.
 *
 * §31: secrets are written to the CUSTOMER's Secrets Manager via the relay
 * (write-through) — secret values never live in the control plane. The API and
 * this workflow never return or emit plaintext secrets (secrets are
 * write-only; events + output carry masked values or secret ARNs only).
 *
 * State machine:
 *   (validate config) → (write via relay to Secrets Manager)
 *   → (health observation) → HEALTHY
 *
 * Config validation checks keys against vendor defaults (customer_id NULL)
 * plus customer overrides (§31). A config update is non-disruptive: the
 * deployment stays HEALTHY throughout and is confirmed HEALTHY on success.
 *
 * The workflow is defined as an async generator yielding WorkflowStep
 * descriptors, executed by the U1 DurableRuntime (todo 7). Every step emits a
 * §62-complete event via the injectable EventEmitter (same pattern as the
 * INSTALL workflow, todo 13).
 */

import {
  step,
  waitForCallback,
  type DurableWorkflow,
  type WorkflowStep,
} from '../durable/durable-runtime.js';

import type { EventActor, EventEmitter } from './event-emitter.js';

import { assertHealthReport } from './preflight.js';

import {
  PreflightError,
  type DeploymentStateStore,
} from './install-workflow.js';

// ── Types ────────────────────────────────────────────────────────────────

/** A single config entry to write (§31). */
export interface ConfigEntry {
  readonly key: string;
  readonly value: string;
  /** True when the value is a secret — written to Secrets Manager, never returned. */
  readonly isSecret: boolean;
}

/** Input to the CONFIG_UPDATE workflow. */
export interface ConfigUpdateInput {
  readonly deploymentId: string;
  readonly customerId: string;
  readonly organizationId: string;
  readonly jobId: string;
  readonly installationId: string;
  /** Config entries to write (§31). Secret values are write-only. */
  readonly entries: readonly ConfigEntry[];
}

/** Output from the CONFIG_UPDATE workflow (secrets masked — no plaintext). */
export interface ConfigUpdateOutput {
  readonly status: 'HEALTHY';
  readonly deploymentId: string;
  /** Applied entries with secret values masked (never plaintext). */
  readonly appliedEntries: readonly ConfigEntry[];
  /** ARNs of the secrets written to the customer's Secrets Manager. */
  readonly secretArns: readonly string[];
}

// ── Seam result types ────────────────────────────────────────────────────

/** Result of validating config keys against vendor defaults + customer overrides. */
export type ConfigValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failureCode: 'INVALID_CONFIG';
      readonly reason: string;
      readonly invalidKeys: readonly string[];
    };

/** Result of writing config via the relay to the customer's Secrets Manager. */
export type ConfigWriteResult =
  | { readonly ok: true; readonly secretArns: readonly string[] }
  | { readonly ok: false; readonly failureCode: 'CONFIG_WRITE_FAILED'; readonly reason: string };

// ── Seam interfaces ──────────────────────────────────────────────────────

/**
 * Validates config keys against vendor defaults + customer overrides (§31).
 *
 * PENDING-AWS: the real validator reads the allowed key set from
 * application_configs (vendor defaults have customer_id NULL; overrides have
 * the customer's id). Tests inject a mock. `validateConfigKeys` is the pure
 * core the real validator delegates to.
 */
export interface ConfigValidator {
  validate(entries: readonly ConfigEntry[]): Promise<ConfigValidationResult>;
}

/**
 * Writes config to the CUSTOMER's Secrets Manager via the relay (§31
 * write-through). Secret values live in the customer account, never the
 * control plane. Returns secret ARNs (not values) on success.
 *
 * PENDING-AWS: the real writer dispatches a CONFIG_UPDATE relay command that
 * writes secrets to the customer's Secrets Manager and non-secrets to the
 * application config. Tests inject a mock with zero AWS.
 */
export interface ConfigWriter {
  write(
    deploymentId: string,
    installationId: string,
    entries: readonly ConfigEntry[],
  ): Promise<ConfigWriteResult>;
}

/** Dependencies injected into the workflow factory. */
export interface ConfigUpdateWorkflowDeps {
  readonly emitter: EventEmitter;
  readonly deploymentStore: DeploymentStateStore;
  readonly configValidator: ConfigValidator;
  readonly configWriter: ConfigWriter;
}

// ── Secret masking (§31 write-only) ──────────────────────────────────────

/** Placeholder emitted in place of a secret value (never the plaintext). */
export const SECRET_MASK = '***';

/** Mask secret values in a config-entry list (write-only secrets, §31). */
export function maskSecrets(
  entries: readonly ConfigEntry[],
): readonly ConfigEntry[] {
  return entries.map((entry) =>
    entry.isSecret
      ? { key: entry.key, value: SECRET_MASK, isSecret: true }
      : entry,
  );
}

// ── Config validation (pure) ─────────────────────────────────────────────

/**
 * Validate config keys against the allowed set (vendor defaults + customer
 * overrides, §31). Rejects empty keys, duplicate keys, and keys outside the
 * allowed set. Pure function — the real ConfigValidator reads the allowed keys
 * from application_configs and delegates here.
 */
export function validateConfigKeys(
  entries: readonly ConfigEntry[],
  allowedKeys: readonly string[],
): ConfigValidationResult {
  const allowed = new Set(allowedKeys);
  const seen = new Set<string>();
  const invalidKeys: string[] = [];
  const reasons: string[] = [];

  for (const entry of entries) {
    if (entry.key.length === 0) {
      invalidKeys.push('');
      reasons.push('empty config key');
      continue;
    }
    if (seen.has(entry.key)) {
      invalidKeys.push(entry.key);
      reasons.push(`duplicate config key "${entry.key}"`);
      continue;
    }
    seen.add(entry.key);
    if (!allowed.has(entry.key)) {
      invalidKeys.push(entry.key);
      reasons.push(
        `config key "${entry.key}" is not in vendor defaults or customer overrides`,
      );
    }
  }

  if (invalidKeys.length > 0) {
    return {
      ok: false,
      failureCode: 'INVALID_CONFIG',
      reason: reasons.join('; '),
      invalidKeys,
    };
  }
  return { ok: true };
}

// ── Error ────────────────────────────────────────────────────────────────

/** Stable §61 failure codes a CONFIG_UPDATE step can fail with. */
export type ConfigUpdateFailureCode = 'INVALID_CONFIG' | 'CONFIG_WRITE_FAILED';

/** Thrown when a config-update step fails, carrying a stable §61 failure code. */
export class ConfigUpdateError extends Error {
  constructor(
    readonly failureCode: ConfigUpdateFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigUpdateError';
  }
}

// ── Workflow factory ─────────────────────────────────────────────────────

/**
 * Create the CONFIG_UPDATE workflow.
 *
 * Returns a DurableWorkflow that can be executed by the DurableRuntime.
 * The deps (emitter, deploymentStore, configValidator, configWriter) are
 * captured at creation time so the workflow generator itself is a pure
 * function of its input.
 */
export function createConfigUpdateWorkflow(
  deps: ConfigUpdateWorkflowDeps,
): DurableWorkflow<ConfigUpdateInput, ConfigUpdateOutput> {
  return async function* configUpdateWorkflow(
    input: ConfigUpdateInput,
  ): AsyncGenerator<WorkflowStep, ConfigUpdateOutput, unknown> {
    const actor: EventActor = { type: 'system' };
    const baseEvent = {
      organizationId: input.organizationId,
      customerId: input.customerId,
      deploymentId: input.deploymentId,
      jobId: input.jobId,
    };
    // Secrets are write-only (§31): every event + the output carry MASKED
    // values (or secret ARNs), never the plaintext secret.
    const maskedEntries = maskSecrets(input.entries);

    // ── Step 1: Validate config ────────────────────────────────────────
    yield step('validate-config', async () => {
      const result = await deps.configValidator.validate(input.entries);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'config.validate',
        previousState: 'HEALTHY',
        requestedState: 'HEALTHY',
        result: result.ok ? 'ok' : `failed:${result.failureCode}`,
        payload: { entries: maskedEntries },
      });

      if (!result.ok) {
        throw new ConfigUpdateError(
          result.failureCode,
          `Config validation failed: ${result.reason}`,
        );
      }
      return { validated: true };
    });

    // ── Step 2: Write via relay to Secrets Manager ─────────────────────
    // The ConfigWriter writes secrets to the CUSTOMER's Secrets Manager via
    // the relay (§31 write-through). Only ARNs come back — never values.
    const written = (yield step('write-config', async () => {
      const result = await deps.configWriter.write(
        input.deploymentId,
        input.installationId,
        input.entries,
      );

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'config.write',
        previousState: 'HEALTHY',
        requestedState: 'HEALTHY',
        result: result.ok ? 'ok' : `failed:${result.failureCode}`,
        payload: {
          entries: maskedEntries,
          ...(result.ok ? { secretArns: result.secretArns } : {}),
        },
      });

      if (!result.ok) {
        throw new ConfigUpdateError(
          result.failureCode,
          `Config write failed: ${result.reason}`,
        );
      }
      return { secretArns: result.secretArns };
    })) as { secretArns: readonly string[] };

    // ── Step 3: Wait for relay health report ────────────────────────────
    // The relay reports health on every poll (todo 12). The health report
    // after the write proves the deployment is still healthy.
    const healthReport = yield waitForCallback(
      `config:${input.installationId}:health-report`,
    );

    // ── Step 4: Observe health → HEALTHY ────────────────────────────────
    // A config update is non-disruptive: the deployment stays HEALTHY. The
    // health report confirms it, and the workflow lands on HEALTHY.
    yield step('observe-health', async () => {
      const healthCheck = assertHealthReport(healthReport, input.installationId);

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'config.health',
        previousState: 'HEALTHY',
        requestedState: 'HEALTHY',
        result: healthCheck.passed ? 'ok' : `failed:${healthCheck.failureCode}`,
        payload: { report: healthReport, check: healthCheck },
      });

      if (!healthCheck.passed) {
        throw new PreflightError(healthCheck);
      }

      await deps.deploymentStore.set(input.deploymentId, 'HEALTHY');

      await deps.emitter.emit(actor, {
        ...baseEvent,
        eventType: 'config.state.healthy',
        previousState: 'HEALTHY',
        requestedState: 'HEALTHY',
        result: 'ok',
        payload: { entries: maskedEntries },
      });

      return { healthy: true };
    });

    return {
      status: 'HEALTHY',
      deploymentId: input.deploymentId,
      appliedEntries: maskedEntries,
      secretArns: written.secretArns,
    };
  };
}

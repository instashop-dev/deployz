import { z } from 'zod';

/**
 * The positive evidence one relay heartbeat carries for release promotion and
 * readiness (`observedState.releaseEvidence`). The relay reports what it saw;
 * the control plane decides. A field the relay could not observe is null, and
 * null never passes a gate.
 */
export const RELEASE_EVIDENCE_VERSION = 1;

/** Evidence older than this cannot promote a release or confirm readiness. */
export const RELEASE_EVIDENCE_MAX_AGE_MS = 10 * 60 * 1000;

const count = z.number().int().nonnegative().nullable();

export const serviceEvidenceSchema = z.object({
  /** The workload id from the spec's verification contract (`web`, `email-worker`, …). */
  workloadId: z.string().min(1),
  /** CloudFormation logical id of the ECS service. */
  serviceLogicalId: z.string().min(1),
  /** False when the service was absent or unreadable; every other field is then null. */
  observed: z.boolean(),
  desiredCount: count,
  runningCount: count,
  /** The PRIMARY ECS deployment's rollout state. */
  rolloutState: z.string().nullable(),
  /**
   * The distinct image digests of every RUNNING task of the service. Empty when
   * no task runs. Null when the tasks could not be read in full.
   */
  runningDigests: z.array(z.string()).nullable(),
  /** ALB target health for a service behind the load balancer; null otherwise or when unread. */
  targets: z
    .object({
      healthy: z.number().int().nonnegative(),
      unhealthy: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type ServiceEvidence = z.infer<typeof serviceEvidenceSchema>;

export const releaseEvidenceSchema = z.object({
  version: z.literal(RELEASE_EVIDENCE_VERSION),
  /** When the relay finished this observation. */
  observedAt: z.iso.datetime(),
  services: z.array(serviceEvidenceSchema),
  /** The public HTTP probe of this poll; null when no probe ran. */
  httpProbe: z
    .object({
      ok: z.boolean(),
      status: z.number().int().nullable(),
      checkedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>;

/** A workload the deployment's frozen spec requires, and whether it serves public traffic. */
export interface ExpectedWorkload {
  readonly id: string;
  readonly serviceLogicalId: string;
  readonly public: boolean;
}

export type ReleaseEvidenceVerdict =
  | { readonly pass: true; readonly digest: string }
  | { readonly pass: false; readonly reason: ReleaseEvidenceFailure };

export type ReleaseEvidenceFailure =
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_STALE'
  | 'NO_EXPECTED_WORKLOADS'
  | 'WORKLOAD_MISSING'
  | 'WORKLOAD_NOT_STARTED'
  | 'ROLLOUT_INCOMPLETE'
  | 'TASKS_INSUFFICIENT'
  | 'DIGEST_UNKNOWN'
  | 'DIGEST_MIXED'
  | 'TARGETS_UNHEALTHY'
  | 'PROBE_MISSING'
  | 'PROBE_FAILED';

function ageOk(iso: string, now: Date, maxAgeMs: number): boolean {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  const age = now.getTime() - at;
  return age >= -60_000 && age <= maxAgeMs;
}

/**
 * Whether one heartbeat's evidence proves that every required workload runs
 * one image digest at full capacity, with healthy targets and a successful
 * public probe. Returns that digest on success. Pure: both the API gate and
 * the tests use it.
 */
export function evaluateReleaseEvidence(
  raw: unknown,
  expected: readonly ExpectedWorkload[],
  now: Date,
  maxAgeMs: number = RELEASE_EVIDENCE_MAX_AGE_MS,
): ReleaseEvidenceVerdict {
  if (raw === undefined || raw === null) return { pass: false, reason: 'EVIDENCE_MISSING' };
  const parsed = releaseEvidenceSchema.safeParse(raw);
  if (!parsed.success) return { pass: false, reason: 'EVIDENCE_INVALID' };
  const evidence = parsed.data;
  if (!ageOk(evidence.observedAt, now, maxAgeMs)) return { pass: false, reason: 'EVIDENCE_STALE' };
  if (expected.length === 0) return { pass: false, reason: 'NO_EXPECTED_WORKLOADS' };

  const digests = new Set<string>();
  let needsProbe = false;
  for (const workload of expected) {
    const service = evidence.services.find(
      (entry) => entry.workloadId === workload.id && entry.serviceLogicalId === workload.serviceLogicalId,
    );
    if (service === undefined || !service.observed) return { pass: false, reason: 'WORKLOAD_MISSING' };
    if (service.desiredCount === null || service.runningCount === null) {
      return { pass: false, reason: 'TASKS_INSUFFICIENT' };
    }
    if (service.desiredCount === 0) return { pass: false, reason: 'WORKLOAD_NOT_STARTED' };
    if (service.rolloutState !== 'COMPLETED') return { pass: false, reason: 'ROLLOUT_INCOMPLETE' };
    if (service.runningCount < service.desiredCount) return { pass: false, reason: 'TASKS_INSUFFICIENT' };
    if (service.runningDigests === null || service.runningDigests.length === 0) {
      return { pass: false, reason: 'DIGEST_UNKNOWN' };
    }
    for (const digest of service.runningDigests) digests.add(digest);
    if (workload.public) {
      needsProbe = true;
      const targets = service.targets;
      if (
        targets === null ||
        targets.healthy === 0 ||
        targets.unhealthy > 0 ||
        targets.pending > 0 ||
        targets.unknown > 0
      ) {
        return { pass: false, reason: 'TARGETS_UNHEALTHY' };
      }
    }
  }
  if (digests.size !== 1) return { pass: false, reason: 'DIGEST_MIXED' };

  if (needsProbe) {
    if (evidence.httpProbe === null) return { pass: false, reason: 'PROBE_MISSING' };
    if (!ageOk(evidence.httpProbe.checkedAt, now, maxAgeMs)) return { pass: false, reason: 'EVIDENCE_STALE' };
    if (!evidence.httpProbe.ok) return { pass: false, reason: 'PROBE_FAILED' };
  }

  const [digest] = digests;
  return { pass: true, digest: digest as string };
}

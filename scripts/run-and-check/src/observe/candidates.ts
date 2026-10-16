import type { AnalysisResultFile, Claim, Recipe } from '../contract.js';

export const FIXED_HEALTH_PATHS = ['/health', '/healthz', '/up', '/api/health', '/status', '/ping', '/_health', '/actuator/health'];
export const FIXED_PORTS = [8080, 3000, 80];

export interface Candidates {
  healthPaths: string[];
  ports: number[];
  migrationCommands: string[];
  workerCommands: string[];
  /** Worker id of a candidate command, when an Analysis named one. */
  workerIds: Record<string, string>;
  /** Variables to start the application without. Recipe inputs first. */
  variables: string[];
  from: string[];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function commands(values: readonly (string | null | undefined)[]): string[] {
  return unique(values.map((value) => value?.trim() ?? '').filter((value) => value.length > 0));
}

function claimValues(claims: readonly Claim[], type: Claim['type']): string[] {
  return claims.filter((claim) => claim.type === type && typeof claim.value === 'string').map((claim) => claim.value as string);
}

/**
 * Candidates come from the recipe, from every given Analysis, and from extra
 * claims to probe (the fixtures' claims); no Analysis is required.
 */
export function collectCandidates(recipe: Recipe, analyses: readonly AnalysisResultFile[], claims: readonly Claim[] = []): Candidates {
  const manifests = analyses.flatMap((file) => (file.manifest === null ? [] : [file.manifest]));
  const workerIds: Record<string, string> = {};
  for (const claim of claims) {
    if (claim.type === 'worker.command' && typeof claim.value === 'string' && claim.subject !== null) workerIds[claim.value] = claim.subject;
  }
  for (const manifest of manifests) {
    for (const worker of manifest.workers ?? []) {
      const command = worker.command.trim();
      if (command && !(command in workerIds)) workerIds[command] = worker.id;
    }
  }
  const analysed = analyses.filter((file) => file.manifest !== null).map((file) => `analysis:${file.analyser}`);
  return {
    healthPaths: unique(['/', ...manifests.map((m) => m.health.path), ...claimValues(claims, 'health.path'), ...FIXED_HEALTH_PATHS]),
    ports: unique([
      ...manifests.flatMap((m) => (m.web.port === null ? [] : [m.web.port])),
      ...claims.filter((claim) => claim.type === 'web.port' && typeof claim.value === 'number').map((claim) => claim.value as number),
      ...FIXED_PORTS,
    ]),
    migrationCommands: commands([...manifests.map((m) => m.migration.command), ...claimValues(claims, 'migration.command')]),
    workerCommands: commands([
      ...manifests.flatMap((m) => [...(m.workers ?? []).map((w) => w.command), m.worker.command]),
      ...claimValues(claims, 'worker.command'),
    ]),
    workerIds,
    variables: unique([
      ...recipe.vendorInputs.map((input) => input.name),
      ...manifests.flatMap((m) =>
        m.environment.variables
          .filter((variable) => variable.required && variable.classification !== 'deployz_managed')
          .map((variable) => variable.key),
      ),
      ...claims.filter((claim) => claim.type === 'env.required' && claim.subject !== null).map((claim) => claim.subject as string),
    ]),
    from: [
      ...(recipe.vendorInputs.length > 0 ? ['recipe'] : []),
      ...unique(analysed),
      ...(claims.length > 0 ? ['claims'] : []),
      'fixed-list',
    ],
  };
}

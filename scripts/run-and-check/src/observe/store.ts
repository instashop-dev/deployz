import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { observationSchema, type Observation, type Recipe } from '../contract.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** sha256 of the recipe as canonical JSON (sorted keys), so a recipe change invalidates an observation. */
export function recipeHash(recipe: Recipe): string {
  return createHash('sha256').update(JSON.stringify(canonical(recipe))).digest('hex');
}

/** Hash of a fixture folder, standing in for the commit of a fixture. */
export async function fixtureCommit(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else hash.update(relative(dir, path).split(sep).join('/')).update(await readFile(path));
    }
  };
  await walk(dir);
  return `fixture-${hash.digest('hex').slice(0, 12)}`;
}

async function readObservation(path: string): Promise<Observation | null> {
  try {
    return observationSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export const finalPath = (observationsDir: string, id: string): string => join(observationsDir, `${id}.json`);
export const partialPath = (runsDir: string, id: string): string => join(runsDir, id, 'observation.partial.json');

/** A stored observation counts only for the same commit and recipe. */
export async function readMatching(path: string, commit: string, hash: string): Promise<Observation | null> {
  const stored = await readObservation(path);
  return stored !== null && stored.commit === commit && stored.recipeHash === hash ? stored : null;
}

export async function writeObservation(path: string, observation: Observation): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(observationSchema.parse(observation), null, 2)}\n`, 'utf8');
}

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { analysisResultFileSchema, recipeSchema, type AnalysisResultFile, type Recipe } from '../contract.js';
import type { BuildRequest, BuiltImage, DockerFn, DockerResources, ProductionEnvironmentFn, Runner, Services } from '../ports.js';
import { observe } from './observe.js';
import type { ObserveDeps } from './types.js';

const HARNESS_VERSION = '1';
const MAX_PARALLEL = 2;
const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface CliArgs {
  repos: string[];
  force: boolean;
}

/** `--repo <id>` (repeatable or a comma list) and `--force`. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const repos: string[] = [];
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') force = true;
    else if (arg === '--repo') {
      const value = argv[(index += 1)];
      if (value === undefined) throw new Error('--repo needs a repository id');
      repos.push(...value.split(',').filter((id) => id.length > 0));
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { repos, force };
}

interface LoadedRecipe {
  recipe: Recipe;
  fixtureDir?: string;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function loadRecipes(): Promise<LoadedRecipe[]> {
  const loaded: LoadedRecipe[] = [];
  const recipesDir = join(HARNESS_ROOT, 'recipes');
  for (const name of (await listDir(recipesDir)).filter((file) => file.endsWith('.yaml')).sort()) {
    loaded.push({ recipe: recipeSchema.parse(parse(await readFile(join(recipesDir, name), 'utf8'))) });
  }
  const fixturesDir = join(HARNESS_ROOT, 'fixtures');
  for (const name of (await listDir(fixturesDir)).filter((dir) => /^F\d+$/.test(dir)).sort()) {
    const fixtureDir = join(fixturesDir, name);
    const text = await readFile(join(fixtureDir, 'recipe.yaml'), 'utf8');
    loaded.push({ recipe: recipeSchema.parse(parse(text)), fixtureDir });
  }
  return loaded;
}

/** Every `analyses/<analyser>/<id>.json` that exists. */
async function loadAnalyses(id: string): Promise<AnalysisResultFile[]> {
  const analysesDir = join(HARNESS_ROOT, 'analyses');
  const files: AnalysisResultFile[] = [];
  for (const analyser of (await listDir(analysesDir)).sort()) {
    try {
      files.push(analysisResultFileSchema.parse(JSON.parse(await readFile(join(analysesDir, analyser, `${id}.json`), 'utf8'))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files;
}

/**
 * Wires the real modules. The export names are fixed at integration; the
 * argument shapes below are this module's assumption.
 */
async function loadRealDeps(): Promise<Omit<ObserveDeps, 'now' | 'log'>> {
  const load = (specifier: string): Promise<unknown> => import(specifier);
  const dockerModule = (await load('../docker/index.js')) as {
    docker: DockerFn;
    labelArgs: (id: string) => string[];
    buildImage: (docker: DockerFn, request: BuildRequest) => Promise<BuiltImage>;
    createDockerResources: (docker: DockerFn, labelArgs: (id: string) => string[]) => DockerResources;
  };
  const { docker, labelArgs, buildImage, createDockerResources } = dockerModule;
  const resources = createDockerResources(docker, labelArgs);
  const { createServices } = (await load('../services/index.js')) as {
    createServices: (options: { docker: DockerFn; resources: DockerResources }) => Services;
  };
  const { createRunner, productionEnvironment } = (await load('../runner/index.js')) as {
    createRunner: (options: { docker: DockerFn; resources: DockerResources }) => Runner;
    productionEnvironment: ProductionEnvironmentFn;
  };
  return {
    buildImage: (request) => buildImage(docker, request),
    services: createServices({ docker, resources }),
    runner: createRunner({ docker, resources }),
    env: productionEnvironment,
  };
}

/** Runs the tasks with at most `limit` at the same time. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const all = await loadRecipes();
  const selected = args.repos.length === 0 ? all : all.filter(({ recipe }) => args.repos.includes(recipe.id));
  const unknown = args.repos.filter((id) => !all.some(({ recipe }) => recipe.id === id));
  if (unknown.length > 0) throw new Error(`no recipe for: ${unknown.join(', ')}`);

  const deps: ObserveDeps = { ...(await loadRealDeps()), now: () => new Date(), log: (line) => console.log(line) };
  const runsDir = join(HARNESS_ROOT, '.runs');
  const observationsDir = join(HARNESS_ROOT, 'observations');
  let failures = 0;

  await pool(selected, MAX_PARALLEL, async ({ recipe, fixtureDir }) => {
    try {
      await observe(recipe, deps, {
        force: args.force,
        observationsDir,
        runsDir,
        analyses: await loadAnalyses(recipe.id),
        harnessVersion: HARNESS_VERSION,
        ...(fixtureDir === undefined ? {} : { fixtureDir }),
      });
    } catch (error) {
      failures += 1;
      console.log(`${recipe.id}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (failures > 0) process.exitCode = 1;
}

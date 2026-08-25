/**
 * CDK app entrypoint for the Deployz control-plane stack.
 *
 * Loads the repo-root .env explicitly because pnpm --filter runs cdk with
 * cwd=packages/cdk, so dotenv's default ./.env lookup would miss the root.
 * The lookup walks up rather than counting '..' hops, so it also resolves
 * from a git worktree (which never gets a copy of the gitignored .env).
 */
import { config } from 'dotenv';

import { findEnvFile, moduleDirectory } from '@deployz/api/find-env-file';

import { App } from 'aws-cdk-lib';
import { DeployzStack } from '../src/deployz-stack.js';

const envFile = findEnvFile(moduleDirectory(import.meta.url));
if (envFile) {
  config({ path: envFile });
  // .env.production sits next to .env and wins over it. .env holds the
  // localhost defaults local development needs, while DeployzStack builds the
  // deployed Lambda's environment from these files alone — so without this a
  // deploy pushes localhost origins into production and, with API_DOMAIN_NAME
  // unset, deletes the api.deployz.dev mapping. The file is absent on a
  // machine that only develops locally, which makes this a no-op there.
  config({ path: `${envFile}.production`, override: true });
}

const app = new App();
new DeployzStack(app, 'Deployz');

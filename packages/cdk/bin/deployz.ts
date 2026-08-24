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
}

const app = new App();
new DeployzStack(app, 'Deployz');

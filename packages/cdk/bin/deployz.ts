/**
 * CDK app entrypoint for the Deployz control-plane stack.
 *
 * Loads the repo-root .env explicitly because pnpm --filter runs cdk with
 * cwd=packages/cdk, so dotenv's default ./.env lookup would miss the root.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

import { App } from 'aws-cdk-lib';
import { DeployzStack } from '../src/deployz-stack.js';

config({ path: resolve(process.cwd(), '..', '..', '.env') });

const app = new App();
new DeployzStack(app, 'Deployz');

/**
 * CDK app entrypoint that synthesizes ONLY the customer BootstrapStack
 * (relay Lambda + IAM + SecretsManager + EventBridge) — the cheap
 * "Deploy to AWS" CloudFormation artifact a customer installs. Used by the
 * real-AWS golden-path run, distinct from bin/deployz.ts (the full control
 * plane).
 *
 * Loads the repo-root .env by walking up from this file, so it resolves from
 * packages/cdk's own cwd and from a git worktree alike (a worktree never gets
 * a copy of the gitignored .env).
 */
import { config } from 'dotenv';

import { findEnvFile, moduleDirectory } from '@deployz/api/find-env-file';

import { App } from 'aws-cdk-lib';
import { BootstrapStack } from '../src/bootstrap/bootstrap-stack.js';

const envFile = findEnvFile(moduleDirectory(import.meta.url));
if (envFile) {
  config({ path: envFile });
}

const app = new App();
new BootstrapStack(app, 'DeployzBootstrap', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
  controlPlaneUrl: process.env.DEPLOYZ_CONTROL_PLANE_URL ?? 'https://api.deployz.dev',
});

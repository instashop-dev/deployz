/**
 * CDK app entrypoint that synthesizes ONLY the customer BootstrapStack
 * (relay Lambda + IAM + SecretsManager + EventBridge) — the cheap
 * "Deploy to AWS" CloudFormation artifact a customer installs. Used by the
 * real-AWS golden-path run, distinct from bin/deployz.ts (the full control
 * plane).
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

import { App } from 'aws-cdk-lib';
import { BootstrapStack } from '../src/bootstrap/bootstrap-stack.js';

config({ path: resolve(process.cwd(), '..', '..', '.env') });

const app = new App();
new BootstrapStack(app, 'DeployzBootstrap', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
  controlPlaneUrl: process.env.DEPLOYZ_CONTROL_PLANE_URL ?? 'https://api.deployz.dev',
});

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildBootstrapQuickCreateUrl,
  DEFAULT_BOOTSTRAP_STACK_NAME,
  DEFAULT_CONTROL_PLANE_URL,
  DEFAULT_REGION,
  FIXTURE_TEMPLATE_URL,
  getInstallLinkConfig,
} from '../src/lib/install-link';

// Locks the web-side Quick Create URL construction against the format
// verified in packages/cdk/test/quick-create.test.ts (the CDK package is the
// source of truth; apps/web mirrors it to avoid bundling aws-cdk-lib).

const FIXTURE_CONFIG = {
  region: DEFAULT_REGION,
  templateUrl: FIXTURE_TEMPLATE_URL,
  controlPlaneUrl: DEFAULT_CONTROL_PLANE_URL,
  stackName: DEFAULT_BOOTSTRAP_STACK_NAME,
} as const;

const EXPECTED_FIXTURE_URL =
  'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1' +
  '#/stacks/create/review' +
  '?templateURL=https%3A%2F%2Ffixtures.deployz.dev%2Ftemplates%2Fbootstrap-template-v1.json' +
  '&stackName=deployz-bootstrap' +
  '&param_ControlPlaneUrl=https%3A%2F%2Fapi.deployz.dev';

describe('buildBootstrapQuickCreateUrl', () => {
  it('produces the deterministic fixture URL byte-for-byte', () => {
    expect(buildBootstrapQuickCreateUrl(FIXTURE_CONFIG)).toBe(EXPECTED_FIXTURE_URL);
  });

  it('URL-encodes the templateURL parameter', () => {
    const url = buildBootstrapQuickCreateUrl(FIXTURE_CONFIG);
    expect(url).toContain('templateURL=https%3A%2F%2F');
    expect(url).not.toContain('templateURL=https://');
  });

  it('carries the non-secret ControlPlaneUrl parameter with the param_ prefix', () => {
    const url = buildBootstrapQuickCreateUrl(FIXTURE_CONFIG);
    expect(url).toContain(`param_ControlPlaneUrl=${encodeURIComponent(DEFAULT_CONTROL_PLANE_URL)}`);
  });

  it('carries no credential, token, or installation identifier', () => {
    const url = buildBootstrapQuickCreateUrl(FIXTURE_CONFIG);
    expect(url).not.toMatch(/token|secret|credential|installationId/i);
  });
});

describe('getInstallLinkConfig', () => {
  const ENV_KEYS = [
    'DEPLOYZ_BOOTSTRAP_REGION',
    'DEPLOYZ_BOOTSTRAP_TEMPLATE_URL',
    'DEPLOYZ_CONTROL_PLANE_URL',
    'DEPLOYZ_BOOTSTRAP_STACK_NAME',
  ] as const;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    saved.clear();
  });

  function stash(key: (typeof ENV_KEYS)[number]) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
  }

  it('falls back to the deterministic fixture config when env is unset', () => {
    for (const key of ENV_KEYS) {
      stash(key);
      delete process.env[key];
    }
    expect(getInstallLinkConfig()).toEqual(FIXTURE_CONFIG);
  });

  it('honors environment overrides (the todo-14 real-template path)', () => {
    for (const key of ENV_KEYS) stash(key);
    process.env.DEPLOYZ_BOOTSTRAP_REGION = 'eu-west-1';
    process.env.DEPLOYZ_BOOTSTRAP_TEMPLATE_URL = 'https://cdn.example.com/t.json';
    process.env.DEPLOYZ_CONTROL_PLANE_URL = 'https://api.example.com';
    process.env.DEPLOYZ_BOOTSTRAP_STACK_NAME = 'custom-stack';

    const config = getInstallLinkConfig();
    expect(config).toEqual({
      region: 'eu-west-1',
      templateUrl: 'https://cdn.example.com/t.json',
      controlPlaneUrl: 'https://api.example.com',
      stackName: 'custom-stack',
    });

    const url = buildBootstrapQuickCreateUrl(config);
    expect(url).toContain('https://eu-west-1.console.aws.amazon.com/');
    expect(url).toContain('stackName=custom-stack');
    expect(url).toContain('param_ControlPlaneUrl=https%3A%2F%2Fapi.example.com');
  });
});

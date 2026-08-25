import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BootstrapStack } from '../src/bootstrap/bootstrap-stack.js';

import { withStableAssetHashes } from './stable-template.js';

/**
 * Collect the IAM action strings from a list of policy statements.
 * Handles both `Action: 'x'` and `Action: ['x', 'y']`, and `NotAction`.
 */
function collectActions(statements: unknown): string[] {
  const out: string[] = [];
  for (const stmt of (statements as Array<Record<string, unknown>>) ?? []) {
    for (const key of ['Action', 'NotAction']) {
      const value = stmt?.[key];
      if (typeof value === 'string') {
        out.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') out.push(item);
        }
      }
    }
  }
  return out;
}

type TemplateResource = { Type: string; Properties?: Record<string, unknown> };

function allResources(template: Template): Record<string, TemplateResource> {
  return (template.toJSON() as { Resources: Record<string, TemplateResource> })['Resources'];
}

/**
 * Replace every bundled-asset hash with a fixed placeholder.
 *
 * esbuild emits a byte-different bundle on Windows and on Linux, so the hash
 * in `Code.S3Key` depends on the machine that ran the test, not on the stack.
 * Without this the committed snapshot fails everywhere except the platform
 * that wrote it.
 */
function withStableAssetHashes(template: unknown): unknown {
  return JSON.parse(
    JSON.stringify(template).replace(/[0-9a-f]{64}\.zip/g, '<asset-hash>.zip'),
  );
}

/**
 * Collect every IAM action granted anywhere in the template: inline role
 * `Policies`, standalone `AWS::IAM::Policy`, and `AWS::IAM::ManagedPolicy`.
 */
function allIamActions(template: Template): string[] {
  const resources = allResources(template);
  const out: string[] = [];
  for (const resource of Object.values(resources)) {
    const type = resource.Type;
    const props = resource.Properties ?? {};
    if (type === 'AWS::IAM::Role') {
      for (const p of (props['Policies'] as Array<Record<string, unknown>>) ?? []) {
        out.push(...collectActions((p['PolicyDocument'] as Record<string, unknown>)?.['Statement']));
      }
    }
    if (type === 'AWS::IAM::Policy' || type === 'AWS::IAM::ManagedPolicy') {
      out.push(...collectActions((props['PolicyDocument'] as Record<string, unknown>)?.['Statement']));
    }
  }
  return out;
}

/**
 * The IAM actions granted to the relay role (found via its permissions
 * boundary). The relay's phase-1 statements are emitted as a standalone
 * `AWS::IAM::Policy` whose `Roles` ref the relay role, so collect those.
 */
function relayRoleActions(template: Template): string[] {
  const resources = allResources(template);
  let relayLogicalId: string | undefined;
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::IAM::Role' && resource.Properties?.['PermissionsBoundary']) {
      relayLogicalId = logicalId;
      break;
    }
  }
  if (!relayLogicalId) {
    throw new Error('Relay role (role with PermissionsBoundary) not found');
  }

  const out: string[] = [];
  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::IAM::Policy') continue;
    const roles = (resource.Properties?.['Roles'] as Array<{ Ref?: string }>) ?? [];
    const referencesRelay = roles.some((r) => r?.['Ref'] === relayLogicalId);
    if (referencesRelay) {
      out.push(...collectActions((resource.Properties?.['PolicyDocument'] as Record<string, unknown>)?.['Statement']));
    }
  }
  return out;
}

function synth() {
  const app = new App();
  const stack = new BootstrapStack(app, 'BootstrapTest');
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe('BootstrapStack', () => {
  it('synthesizes without errors', () => {
    const { template } = synth();
    expect(template).toBeDefined();
  });

  it('creates the relay Lambda with install identity in the environment', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Lambda::Function', 4); // relay + install-id + provider framework + log-retention
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DEPLOYZ_CONTROL_PLANE_URL: Match.anyValue(),
          DEPLOYZ_INSTALLATION_ID: Match.anyValue(),
          DEPLOYZ_CREDENTIAL_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
  });

  it('schedules the relay to poll every 5 minutes', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  it('generates the communication credential as a bootstrap secret (not a parameter)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    // GenerateSecretString mints the token at deploy time — a secret passed in
    // as a template parameter would instead carry a `SecretString`/dynamic ref.
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: {
        GenerateStringKey: 'token',
        SecretStringTemplate: '{}',
      },
    });
  });

  it('mints the installation identifier via a custom resource', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  it('tags every taggable resource with deployz:component=bootstrap', () => {
    const { template } = synth();
    // AWS::IAM::ManagedPolicy is excluded: CloudFormation has no `Tags`
    // property for managed policies, so they cannot carry deployz: tags.
    const taggable = [
      'AWS::IAM::Role',
      'AWS::Lambda::Function',
      'AWS::SecretsManager::Secret',
      'AWS::Events::Rule',
    ] as const;

    for (const type of taggable) {
      const resources = template.findResources(type) as Record<
        string,
        { Properties?: Record<string, unknown> }
      >;
      for (const [logicalId, resource] of Object.entries(resources)) {
        const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
        const component = tags.find((t) => t['Key'] === 'deployz:component');
        expect(component?.['Value'], `${type} ${logicalId}`).toBe('bootstrap');
      }
    }
  });

  it('tags the downstream resources with deployz:installation', () => {
    const { template } = synth();
    const json = template.toJSON();
    const resources = json['Resources'] as Record<string, Record<string, unknown>>;

    const hasTag = (props: Record<string, unknown> | undefined, key: string) =>
      ((props?.['Tags'] as Array<Record<string, unknown>>) ?? []).some(
        (t) => t['Key'] === key,
      );

    // The relay role, relay function, credential secret and schedule rule must
    // carry deployz:installation. The install-id generator Lambda/role cannot
    // (it mints the id) and carries only deployz:component.
    const relayRole = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::IAM::Role' && r['Properties']?.['PermissionsBoundary'],
    );
    expect(hasTag(relayRole?.['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);

    const relayFn = Object.values(resources).find(
      (r) =>
        r['Type'] === 'AWS::Lambda::Function' &&
        (r['Properties']?.['Environment'] as Record<string, unknown>)?.Variables?.[
          'DEPLOYZ_INSTALLATION_ID'
        ],
    );
    expect(hasTag(relayFn?.['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);

    const secret = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::SecretsManager::Secret',
    );
    expect(hasTag(secret?.['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);

    const rule = Object.values(resources).find((r) => r['Type'] === 'AWS::Events::Rule');
    expect(hasTag(rule?.['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);
  });

  it('grants the relay role a permissions boundary', () => {
    const { stack } = synth();
    expect(stack.relayRole.permissionsBoundary).toBeDefined();
    const resources = allResources(Template.fromStack(stack));
    const relayRole = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.['PermissionsBoundary'],
    );
    expect(relayRole).toBeDefined();
  });

  it('gives the relay role least-privilege phase-1 permissions (logs write + secret access)', () => {
    const { template } = synth();
    const actions = relayRoleActions(template);

    // Phase 1 allows writing logs (required for CloudWatch) ...
    expect(actions).toContain('logs:CreateLogGroup');
    expect(actions).toContain('logs:CreateLogStream');
    expect(actions).toContain('logs:PutLogEvents');
    // ... and reading/writing the bootstrap credential secret ...
    expect(actions).toContain('secretsmanager:GetSecretValue');
    // ... but NOTHING else (no cloudformation, ecs, ec2, rds at install time).
    expect(actions).not.toContain('cloudformation:CreateStack');
    expect(actions).not.toContain('ecs:UpdateService');
    expect(actions).not.toContain('rds:ModifyDBInstance');
  });

  it('does NOT attach the phase-2 provisioner policy at install time (two-phase)', () => {
    const { stack } = synth();
    const resources = allResources(Template.fromStack(stack));
    const relayRole = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.['PermissionsBoundary'],
    );
    // The role carries phase-1 statements + a boundary, but no managed policy
    // (the provisioner policy) is attached yet — the control plane attaches
    // it after first contact.
    expect(relayRole?.Properties?.['ManagedPolicyArns']).toBeUndefined();
    expect(stack.provisionerPolicy).toBeDefined();
  });

  it('constrains the provisioner policy to the deployz: tag boundary', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const conditions = statements.flatMap((s) => {
      const cond = s['Condition'] as Record<string, Record<string, string>> | undefined;
      return cond ? Object.values(cond).map((c) => Object.keys(c)) : [];
    });

    const flatKeys = conditions.flat();
    expect(flatKeys).toContain('aws:RequestTag/deployz:installation');
    expect(flatKeys).toContain('aws:ResourceTag/deployz:installation');
    expect(flatKeys).toContain('iam:PassedToService');
  });

  it('DENIES log read (§16: no logs:GetLogEvents / logs:FilterLogEvents)', () => {
    const { stack, template } = synth();

    // The relay role's own phase-1 grants ...
    const relay = relayRoleActions(template);
    // ... the permissions boundary (the ceiling) ...
    const boundary = collectActions(
      stack.permissionsBoundary.document.toJSON()['Statement'],
    );
    // ... and the phase-2 provisioner policy.
    const provisioner = collectActions(
      stack.provisionerPolicy.document.toJSON()['Statement'],
    );

    for (const actions of [relay, boundary, provisioner]) {
      expect(actions).not.toContain('logs:GetLogEvents');
      expect(actions).not.toContain('logs:FilterLogEvents');
    }

    // Strongest form: NO IAM policy anywhere in the bootstrap template grants
    // log read — the §16 data boundary is enforced at IAM across the stack.
    const all = allIamActions(template);
    expect(all).not.toContain('logs:GetLogEvents');
    expect(all).not.toContain('logs:FilterLogEvents');
  });

  it('carries no secret template parameters', () => {
    const { template } = synth();
    const json = template.toJSON();
    const params = (json['Parameters'] ?? {}) as Record<string, Record<string, unknown>>;

    // CDK synthesizes a synthetic BootstrapVersion parameter (not a secret).
    const names = Object.keys(params);
    expect(names).toContain('BootstrapVersion');
    const appParams = Object.fromEntries(
      Object.entries(params).filter(([name]) => name !== 'BootstrapVersion'),
    );

    for (const [name, param] of Object.entries(appParams)) {
      // No parameter may be NoEcho (a NoEcho param would carry a credential).
      expect(param['NoEcho'], `parameter ${name} must not be NoEcho`).not.toBe(true);
      // No parameter name may imply a credential.
      expect(name.toLowerCase(), `parameter ${name} looks like a credential`).not.toMatch(
        /token|secret|credential|password|api.?key/,
      );
      // Both application parameters are non-secret.
      expect(['ControlPlaneUrl', 'EnrollmentCode']).toContain(name);
    }
    // EnrollmentCode is single use: the control plane burns it when the relay
    // first binds, and refuses to bind it to a second relay afterwards. It is
    // not the relay's communication credential — CloudFormation still mints
    // that inside the customer's account, and it is still never a parameter.
    expect(Object.keys(appParams).sort()).toEqual(['ControlPlaneUrl', 'EnrollmentCode']);
  });

  it('exports the control-plane handshake outputs', () => {
    const { template } = synth();
    const outputs = Object.keys(template.findOutputs('*'));
    expect(outputs).toContain('ExportBootstrapTestRelayFunctionArn');
    expect(outputs).toContain('ExportBootstrapTestCredentialSecretArn');
    expect(outputs).toContain('ExportBootstrapTestProvisionerPolicyArn');
    expect(outputs).toContain('ExportBootstrapTestInstallationId');
  });

  it('matches the committed snapshot', () => {
    const { template } = synth();
    expect(withStableAssetHashes(template.toJSON())).toMatchSnapshot();
  });
});

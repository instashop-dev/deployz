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

  it('attaches the provisioner policy, under the permissions boundary', () => {
    const { stack } = synth();
    const resources = allResources(Template.fromStack(stack));
    const relayRole = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.['PermissionsBoundary'],
    );
    // This used to assert the opposite, on the theory that the control plane
    // would attach the policy after first contact. It cannot: §15 forbids
    // Deployz from holding credentials in the customer's account, so there
    // is no principal able to make that call. The boundary — which the role
    // still carries — is what caps the grant.
    expect(relayRole?.Properties?.['ManagedPolicyArns']).toBeDefined();
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

  it('grants the relay least-privilege custom-domain ACM + listener permissions', () => {
    const { stack } = synth();
    const actions = collectActions(stack.provisionerPolicy.document.toJSON()['Statement']);

    // ACM certificate lifecycle.
    expect(actions).toContain('acm:RequestCertificate');
    expect(actions).toContain('acm:AddTagsToCertificate');
    expect(actions).toContain('acm:DescribeCertificate');
    expect(actions).toContain('acm:DeleteCertificate');
    expect(actions).toContain('acm:ListTagsForCertificate');

    // ELB listener management on the deployment's ALB.
    expect(actions).toContain('elasticloadbalancing:DescribeListeners');
    expect(actions).toContain('elasticloadbalancing:DescribeListenerCertificates');
    expect(actions).toContain('elasticloadbalancing:DescribeTags');
    expect(actions).toContain('elasticloadbalancing:DescribeRules');
    expect(actions).toContain('elasticloadbalancing:CreateListener');
    expect(actions).toContain('elasticloadbalancing:ModifyListener');
    expect(actions).toContain('elasticloadbalancing:DeleteListener');
    expect(actions).toContain('elasticloadbalancing:AddListenerCertificates');
    expect(actions).toContain('elasticloadbalancing:RemoveListenerCertificates');

    // No wildcard ACM grant anywhere.
    expect(actions).not.toContain('acm:*');

    // Statement structure: ACM request is request-tag-conditioned, ACM manage
    // and the ELB writes are resource-tag-conditioned, and the ELB Describe*
    // set is condition-free (Describe actions don't support resource scoping).
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);

    const acmRequestStatement = findBySid('ProvisionerAcmRequest');
    expect(acmRequestStatement).toBeDefined();
    expect(
      (acmRequestStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:RequestTag/deployz:installation'],
    ).toBeDefined();

    const acmManageStatement = findBySid('ProvisionerAcmManage');
    expect(acmManageStatement).toBeDefined();
    expect(
      (acmManageStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();

    const domainIngressDescribeStatement = findBySid('ProvisionerDomainIngressDescribe');
    expect(domainIngressDescribeStatement).toBeDefined();
    expect(domainIngressDescribeStatement?.['Condition']).toBeUndefined();

    const domainIngressWriteStatement = findBySid('ProvisionerDomainIngressWrite');
    expect(domainIngressWriteStatement).toBeDefined();
    expect(
      (domainIngressWriteStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();
  });

  it('grants the relay least-privilege ElastiCache permissions (Redis MVP)', () => {
    const { stack } = synth();
    const actions = collectActions(stack.provisionerPolicy.document.toJSON()['Statement']);

    expect(actions).toContain('elasticache:CreateCacheCluster');
    expect(actions).toContain('elasticache:DeleteCacheCluster');
    expect(actions).toContain('elasticache:DescribeCacheClusters');
    expect(actions).toContain('elasticache:ModifyCacheCluster');
    expect(actions).toContain('elasticache:CreateCacheSubnetGroup');
    expect(actions).toContain('elasticache:DeleteCacheSubnetGroup');
    expect(actions).toContain('elasticache:DescribeCacheSubnetGroups');
    expect(actions).toContain('elasticache:AddTagsToResource');
    expect(actions).toContain('elasticache:ListTagsForResource');

    // No wildcard ElastiCache grant.
    expect(actions).not.toContain('elasticache:*');

    // Statement structure mirrors the ACM/domain-ingress precedent:
    // Create is request-tag-conditioned (brand-new resource, no tag yet),
    // Delete/Modify/read-tags is resource-tag-conditioned (resource already
    // carries the installation tag), and Describe is condition-free because
    // ElastiCache Describe* calls don't support resource-level
    // permissions/conditions.
    //
    // elasticache:AddTagsToResource sits in the CREATE bucket, not manage:
    // a resource-tag condition can never authorize the FIRST call that tags
    // a brand-new, untagged cache (same reasoning bootstrap-stack.ts applies
    // to acm:AddTagsToCertificate, which rides with acm:RequestCertificate
    // rather than the ACM manage/delete bucket).
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;
    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);
    const sortedActions = (statement: Record<string, unknown> | undefined): string[] =>
      [...((statement?.['Action'] as string[] | undefined) ?? [])].sort();

    const cacheCreateStatement = findBySid('ProvisionerCacheCreate');
    expect(cacheCreateStatement).toBeDefined();
    expect(sortedActions(cacheCreateStatement)).toEqual(
      [
        'elasticache:AddTagsToResource',
        'elasticache:CreateCacheCluster',
        'elasticache:CreateCacheSubnetGroup',
      ].sort(),
    );
    expect(
      (cacheCreateStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:RequestTag/deployz:installation'],
    ).toBeDefined();

    const cacheManageStatement = findBySid('ProvisionerCacheManage');
    expect(cacheManageStatement).toBeDefined();
    expect(sortedActions(cacheManageStatement)).toEqual(
      [
        'elasticache:DeleteCacheCluster',
        'elasticache:ModifyCacheCluster',
        'elasticache:DeleteCacheSubnetGroup',
        'elasticache:ListTagsForResource',
      ].sort(),
    );
    // AddTagsToResource is explicitly NOT in the manage bucket.
    expect(cacheManageStatement?.['Action']).not.toContain('elasticache:AddTagsToResource');
    expect(
      (cacheManageStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();

    const cacheDescribeStatement = findBySid('ProvisionerCacheDescribe');
    expect(cacheDescribeStatement).toBeDefined();
    expect(sortedActions(cacheDescribeStatement)).toEqual(
      ['elasticache:DescribeCacheClusters', 'elasticache:DescribeCacheSubnetGroups'].sort(),
    );
    expect(cacheDescribeStatement?.['Condition']).toBeUndefined();

    // Every ElastiCache action granted must also be within the permissions
    // boundary (the ceiling).
    const boundaryActions = collectActions(
      stack.permissionsBoundary.document.toJSON()['Statement'],
    );
    for (const action of actions.filter((a) => a.startsWith('elasticache:'))) {
      expect(boundaryActions).toContain(action);
    }
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
      // Every application parameter is non-secret: two public URLs and a
      // single-use enrollment code.
      expect(['ControlPlaneUrl', 'EnrollmentCode', 'ApplicationTemplateUrl']).toContain(name);
    }
    // EnrollmentCode is single use: the control plane burns it when the relay
    // first binds, and refuses to bind it to a second relay afterwards. It is
    // not the relay's communication credential — CloudFormation still mints
    // that inside the customer's account, and it is still never a parameter.
    expect(Object.keys(appParams).sort()).toEqual([
      'ApplicationTemplateUrl',
      'ControlPlaneUrl',
      'EnrollmentCode',
    ]);
  });

  it('exports the control-plane handshake outputs', () => {
    const { template } = synth();
    const outputs = Object.keys(template.findOutputs('*'));
    expect(outputs).toContain('ExportBootstrapTestRelayFunctionArn');
    expect(outputs).toContain('ExportBootstrapTestCredentialSecretArn');
    expect(outputs).toContain('ExportBootstrapTestProvisionerPolicyArn');
    expect(outputs).toContain('ExportBootstrapTestInstallationId');
    expect(outputs).toContain('ExportBootstrapTestApplicationExecutionRoleArn');
  });

  it('lets the relay read its own application stack', () => {
    const template = Template.fromStack(new BootstrapStack(new App(), 'TestStack'));

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'RelayVerifyInstallation',
            Effect: 'Allow',
            Action: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackResources'],
          }),
        ]),
      },
    });
  });

  it('matches the committed snapshot', () => {
    const { template } = synth();
    expect(withStableAssetHashes(template.toJSON())).toMatchSnapshot();
  });
});

// ── Provisioning the application stack ──────────────────────────────────────
//
// Everything below exists because the relay's INSTALL executor calls
// `CreateStack`, and nothing in this stack previously let it. The
// provisioner policy was defined and attached to no principal, and its
// `iam:PassRole` pointed at `role/deployz/*`, where no role existed.

describe('BootstrapStack — application provisioning', () => {
  /** Statements of every inline policy attached to `role`. */
  function inlinePolicyStatements(
    template: Template,
    roleLogicalId: string,
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const resource of Object.values(allResources(template))) {
      if (resource.Type !== 'AWS::IAM::Policy') continue;
      const roles = (resource.Properties?.['Roles'] as Array<{ Ref?: string }>) ?? [];
      if (!roles.some((r) => r?.['Ref'] === roleLogicalId)) continue;
      out.push(
        ...(((resource.Properties?.['PolicyDocument'] as Record<string, unknown>)?.[
          'Statement'
        ] as Array<Record<string, unknown>>) ?? []),
      );
    }
    return out;
  }

  function findRole(
    template: Template,
    predicate: (resource: TemplateResource) => boolean,
  ): { logicalId: string; resource: TemplateResource } {
    for (const [logicalId, resource] of Object.entries(allResources(template))) {
      if (resource.Type === 'AWS::IAM::Role' && predicate(resource)) {
        return { logicalId, resource };
      }
    }
    throw new Error('No matching IAM role in the template');
  }

  const executionRole = (template: Template) =>
    findRole(template, (r) => r.Properties?.['Path'] === '/deployz/');

  const relayRole = (template: Template) =>
    findRole(template, (r) => Boolean(r.Properties?.['PermissionsBoundary']));

  it('attaches the provisioner policy to the relay role', () => {
    const { template } = synth();
    const { resource } = relayRole(template);

    // Nothing can attach this later: the control plane holds no credentials
    // in the customer's account (§15), so a policy left unattached here is
    // one the relay never gets. Without it `cloudformation:CreateStack` is
    // denied and every install fails.
    expect(resource.Properties?.['ManagedPolicyArns']).toBeDefined();
  });

  it('creates a CloudFormation execution role where iam:PassRole can find it', () => {
    const { template } = synth();
    const { resource } = executionRole(template);

    // The relay's existing PassRole is scoped to `arn:aws:iam::*:role/deployz/*`,
    // which only matches a role created at this path.
    expect(resource.Properties?.['Path']).toBe('/deployz/');
  });

  it('lets only CloudFormation assume the execution role, and only for this account', () => {
    const { template } = synth();
    const { resource } = executionRole(template);
    const trust = JSON.stringify(resource.Properties?.['AssumeRolePolicyDocument']);

    expect(trust).toContain('cloudformation.amazonaws.com');
    expect(trust).toContain('aws:SourceAccount');
  });

  it('grants the execution role the services the application stack provisions', () => {
    const { template } = synth();
    const actions = inlinePolicyStatements(template, executionRole(template).logicalId).flatMap(
      (s) => collectActions([s]),
    );

    for (const action of [
      'ec2:CreateVpc',
      'ec2:CreateNatGateway',
      'ec2:CreateSecurityGroup',
      'ecs:CreateCluster',
      'ecs:CreateService',
      'ecs:RegisterTaskDefinition',
      'rds:CreateDBInstance',
      'rds:CreateDBSubnetGroup',
      'elasticloadbalancing:CreateLoadBalancer',
      'elasticloadbalancing:CreateTargetGroup',
      'elasticloadbalancing:CreateListener',
      's3:CreateBucket',
      'secretsmanager:CreateSecret',
      'logs:CreateLogGroup',
      'iam:CreateRole',
      'elasticache:CreateCacheCluster',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('never grants the execution role a service wildcard', () => {
    const { template } = synth();
    const actions = inlinePolicyStatements(template, executionRole(template).logicalId).flatMap(
      (s) => collectActions([s]),
    );

    for (const action of actions) {
      expect(action).not.toBe('*');
      expect(action.endsWith(':*')).toBe(false);
    }
  });

  it('scopes the execution role creates to this installation tag', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const creating = statements.find((s) =>
      collectActions([s]).includes('rds:CreateDBInstance'),
    );
    const condition = JSON.stringify(creating?.['Condition']);

    expect(condition).toContain('aws:RequestTag/deployz:installation');
  });

  it('scopes the execution role deletes to resources already carrying the tag', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const deleting = statements.find((s) =>
      collectActions([s]).includes('rds:DeleteDBInstance'),
    );
    const condition = JSON.stringify(deleting?.['Condition']);

    expect(condition).toContain('aws:ResourceTag/deployz:installation');
  });

  it('restricts what the execution role may pass a role to', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const passRole = statements.find((s) => collectActions([s]).includes('iam:PassRole'));
    const condition = JSON.stringify(passRole?.['Condition']);

    expect(condition).toContain('iam:PassedToService');
    expect(condition).toContain('ecs-tasks.amazonaws.com');
  });

  it('restricts which service-linked roles the execution role may create', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const slr = statements.find((s) =>
      collectActions([s]).includes('iam:CreateServiceLinkedRole'),
    );
    const condition = JSON.stringify(slr?.['Condition']);

    expect(condition).toContain('iam:AWSServiceName');
  });

  it('tells the relay which template to install and which role to use', () => {
    const { template } = synth();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DEPLOYZ_APPLICATION_TEMPLATE_URL: Match.anyValue(),
          DEPLOYZ_APPLICATION_EXECUTION_ROLE_ARN: Match.anyValue(),
        }),
      }),
    });
  });

  it('lets the relay remember a command it has not finished', () => {
    const { template } = synth();
    const actions = relayRoleActions(template);

    // The relay defers an INSTALL whose stack outlives the invocation and
    // picks it up on the next poll. Without somewhere durable to write that
    // down, the job sits in RUNNING forever.
    expect(actions).toContain('ssm:PutParameter');
    expect(actions).toContain('ssm:GetParameter');
    expect(actions).toContain('ssm:DeleteParameter');
  });

  it('scopes the relay pending-command parameter to its own installation', () => {
    const { template } = synth();
    const { logicalId } = relayRole(template);
    const statements = inlinePolicyStatements(template, logicalId);

    const ssm = statements.find((s) => collectActions([s]).includes('ssm:PutParameter'));
    expect(JSON.stringify(ssm?.['Resource'])).toContain('parameter/deployz/');
  });

  it('keeps the permissions boundary above everything the relay is granted', () => {
    const { stack, template } = synth();
    const boundary = collectActions(stack.permissionsBoundary.document.toJSON()['Statement']);

    for (const action of relayRoleActions(template)) {
      expect(boundary).toContain(action);
    }
    for (const action of collectActions(stack.provisionerPolicy.document.toJSON()['Statement'])) {
      expect(boundary).toContain(action);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BootstrapStack, IAM_MANAGED_POLICY_MAX_CHARS } from '../src/bootstrap/bootstrap-stack.js';

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

  it('creates two mutually exclusive credential secrets (DZ-AUDIT-013, replaces one secret)', () => {
    const { template } = synth();
    // DZ-AUDIT-013: two CfnSecrets, one always created (conditioned away).
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    // At least one of them uses GenerateSecretString for legacy deployments.
    const generated = Object.values(allResources(template)).filter(
      (r) => r.Type === 'AWS::SecretsManager::Secret' && r.Properties?.['GenerateSecretString'],
    );
    expect(generated.length).toBeGreaterThanOrEqual(1);
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

    const secrets = Object.values(resources).filter(
      (r) => r['Type'] === 'AWS::SecretsManager::Secret',
    );
    for (const secret of secrets) {
      expect(hasTag(secret['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);
    }

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

  it('attaches BOTH provisioner managed policies to the relay role (ProvisionerPolicy + ProvisionerPurgePolicy)', () => {
    const { stack, template } = synth();
    const resources = allResources(template);
    const relayRole = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.['PermissionsBoundary'],
    );
    const arns = (relayRole?.Properties?.['ManagedPolicyArns'] as unknown[]) ?? [];
    // Split purely for the per-policy IAM size quota — the role still needs
    // both attached to have the full phase 2 grant.
    expect(arns).toHaveLength(2);
    expect(arns).toContainEqual(stack.resolve(stack.provisionerPolicy.managedPolicyArn));
    expect(arns).toContainEqual(stack.resolve(stack.provisionerPurgePolicy.managedPolicyArn));
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

    // AddTags: the relay creates the 443 listener itself, so — unlike every
    // other domain-ingress write — the resource carries no tag yet the FIRST
    // time this runs. A resource-tag condition could never match an
    // untagged listener (that was the production defect), so this is
    // request-tag-conditioned instead, like acm:RequestCertificate /
    // elasticache:AddTagsToResource.
    expect(actions).toContain('elasticloadbalancing:AddTags');
    const domainIngressTagStatement = findBySid('ProvisionerDomainIngressTag');
    expect(domainIngressTagStatement).toBeDefined();
    expect(collectActions([domainIngressTagStatement])).toEqual(['elasticloadbalancing:AddTags']);
    expect(
      (domainIngressTagStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:RequestTag/deployz:installation'],
    ).toBeDefined();
    expect(
      (domainIngressTagStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'ForAllValues:StringEquals'
      ]?.['aws:TagKeys'],
    ).toEqual(['deployz:installation']);
  });

  it('grants the relay least-privilege regional ACM permissions, tagged by customer scope (regional HTTPS certificates)', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;
    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);

    // No separate regional REQUEST statement: ProvisionerAcmRequest carries
    // no aws:TagKeys restriction, so the relay can already tag a regional
    // certificate it requests with deployz:customer-scope in addition to the
    // deployz:installation request tag that statement requires.
    expect(findBySid('ProvisionerRegionalAcmRequest')).toBeUndefined();
    const acmRequestConditionKeys = Object.keys(
      (findBySid('ProvisionerAcmRequest')?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ] ?? {},
    );
    expect(acmRequestConditionKeys).toEqual(['aws:RequestTag/deployz:installation']);
    expect(findBySid('ProvisionerAcmRequest')?.['Condition']).not.toHaveProperty(
      'ForAllValues:StringEquals',
    );

    // Only a MANAGE statement is added, scoped by the customer-scope resource
    // tag, so a sibling installation that did not request the certificate can
    // still describe/delete it.
    const regionalManageStatement = findBySid('ProvisionerRegionalAcmManage');
    expect(regionalManageStatement).toBeDefined();
    // acm:ListTagsForCertificate is deliberately left out here — it is
    // already granted, condition-free, by RelayPurgeAcmDiscover — to keep
    // the permissions boundary under the IAM policy-size quota.
    expect(collectActions([regionalManageStatement]).sort()).toEqual(
      ['acm:DescribeCertificate', 'acm:DeleteCertificate'].sort(),
    );
    // A plain Ref, not Fn::If: the CustomerScope default ('none') can never
    // match a real 12-lowercase-hex scope, so an unscoped installation's
    // statement is already inert without a sentinel condition. The value is
    // an unresolved CDK token here (stack.provisionerPolicy.document.toJSON()
    // does not run through the stack's token resolver), so resolve it first.
    const regionalManageConditionValue = stack.resolve(
      (regionalManageStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:customer-scope'],
    );
    expect(regionalManageConditionValue).toEqual({ Ref: 'CustomerScope' });

    // Never tagged deployz:installation — that would defeat sharing across
    // sibling installations of the same customer.
    expect(
      Object.keys(
        (regionalManageStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
          'StringEquals'
        ] ?? {},
      ),
    ).not.toContain('aws:ResourceTag/deployz:installation');

    // The permissions boundary (the ceiling) carries the same grant.
    const boundaryActions = collectActions(
      stack.permissionsBoundary.document.toJSON()['Statement'],
    );
    for (const action of collectActions([regionalManageStatement])) {
      expect(boundaryActions).toContain(action);
    }
  });

  it('grants the ELB lookups the domain executor makes unconditionally', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);
    const actionsOf = (sid: string) => collectActions([findBySid(sid)]);

    // `findTaggedLoadBalancer` calls DescribeLoadBalancers with no ARN filter
    // and `describeTargetGroups` filters by load balancer, so neither request
    // carries a resource whose tags IAM can read. A resource-tag condition can
    // therefore never match, and the grant has to be condition-free — the same
    // exception the other ELB Describe* actions already take.
    expect(actionsOf('ProvisionerDomainIngressDescribe')).toContain(
      'elasticloadbalancing:DescribeLoadBalancers',
    );
    expect(actionsOf('ProvisionerDomainIngressDescribe')).toContain(
      'elasticloadbalancing:DescribeTargetGroups',
    );
    expect(actionsOf('ProvisionerAppResourceManage')).not.toContain(
      'elasticloadbalancing:DescribeLoadBalancers',
    );
    expect(actionsOf('ProvisionerAppResourceManage')).not.toContain(
      'elasticloadbalancing:DescribeTargetGroups',
    );
  });

  it('grants the relay least-privilege ElastiCache permissions (Redis MVP)', () => {
    const { stack } = synth();
    const actions = collectActions(stack.provisionerPolicy.document.toJSON()['Statement']);

    expect(actions).toContain('elasticache:CreateCacheCluster');
    expect(actions).toContain('elasticache:DeleteCacheCluster');
    expect(actions).toContain('elasticache:DescribeCacheClusters');
    expect(actions).toContain('elasticache:ModifyCacheCluster');
    expect(actions).toContain('elasticache:DeleteReplicationGroup');
    expect(actions).toContain('elasticache:DescribeReplicationGroups');
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
        'elasticache:DeleteReplicationGroup',
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
      [
        'elasticache:DescribeCacheClusters',
        'elasticache:DescribeReplicationGroups',
        'elasticache:DescribeCacheSubnetGroups',
      ].sort(),
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

  it('grants the relay ecs:RunTask for the deploy-time migration one-off', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const run = statements.find((s) => collectActions([s]).includes('ecs:RunTask'));
    expect(run).toBeDefined();
    // RunTask is evaluated against the cluster AND the task definition AND
    // further untagged resource ARNs in some configurations — the same
    // multi-resource auth shape ecs:DeregisterTaskDefinition documents — so
    // no tag condition could reliably match (condition-free by design).
    expect(run?.['Condition']).toBeUndefined();

    // The permissions boundary (the ceiling) covers it too.
    const boundary = collectActions(stack.permissionsBoundary.document.toJSON()['Statement']);
    expect(boundary).toContain('ecs:RunTask');
  });

  it('grants the relay tag-scoped read/write of the application config secret for CONFIG_UPDATE (DEPLOY-012)', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()['Statement'] as Array<Record<string, unknown>>;
    const grant = statements.find((s) => s['Sid'] === 'RelayInstallationSecrets');
    expect(collectActions([grant]).sort()).toEqual([
      'secretsmanager:DeleteSecret',
      'secretsmanager:GetSecretValue',
      'secretsmanager:PutSecretValue',
    ]);
    expect(
      (grant?.['Condition'] as Record<string, Record<string, unknown>>)?.['StringEquals']?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();
    // The boundary caps the role: the same grant must be there too (without its Sid).
    const boundary = stack.permissionsBoundary.document.toJSON()['Statement'] as Array<Record<string, unknown>>;
    expect(
      boundary.some((s) => collectActions([s]).includes('secretsmanager:PutSecretValue') && s['Condition'] !== undefined),
    ).toBe(true);
  });

  it('grants the relay the Phase 9 purge discovery reads and tag-scoped retained-credential deletion', () => {
    const { stack } = synth();
    // Purge/discovery statements live in provisionerPurgePolicy (split from
    // provisionerPolicy purely for the IAM size quota); search the union.
    const statements = [
      ...(stack.provisionerPolicy.document.toJSON()['Statement'] as Array<Record<string, unknown>>),
      ...(stack.provisionerPurgePolicy.document.toJSON()['Statement'] as Array<Record<string, unknown>>),
    ];
    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);
    const actionsOf = (sid: string) => collectActions([findBySid(sid)]);

    // RDS orphan discovery is condition-free (DescribeDBInstances has no
    // resource-level permissions; ListTagsForResource does not evaluate tag
    // conditions) — the purge code verifies ownership from the tags itself.
    const rdsDiscover = findBySid('RelayPurgeRdsDiscover');
    expect(actionsOf('RelayPurgeRdsDiscover')).toEqual([
      'rds:DescribeDBInstances',
      'rds:ListTagsForResource',
    ]);
    expect(rdsDiscover?.['Condition']).toBeUndefined();

    // Secrets: ListSecrets + DescribeSecret are condition-free discovery
    // reads (a tag condition on DescribeSecret would deny the ownership check
    // for every foreign secret in the account); the destructive delete is
    // scoped to the retained DB-credential secrets that already carry the
    // installation tag.
    const secretsList = findBySid('RelayPurgeSecretsList');
    expect(actionsOf('RelayPurgeSecretsList')).toEqual([
      'secretsmanager:ListSecrets',
      'secretsmanager:DescribeSecret',
    ]);
    expect(secretsList?.['Condition']).toBeUndefined();

    const secretsDelete = findBySid('RelayInstallationSecrets');
    expect(actionsOf('RelayInstallationSecrets')).toContain('secretsmanager:DeleteSecret');
    expect(
      (secretsDelete?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();

    // Phase 11 ACM orphan sweep: condition-free list (ACM certs cannot be
    // tag-scoped at list time; ownership is verified from the returned tags),
    // deletion already covered by the tag-scoped ProvisionerAcmManage grant.
    expect(findBySid('RelayPurgeAcmDiscover')).toBeDefined();
    // Both reads condition-free: a tag-scoped ListTagsForCertificate is denied
    // on every certificate that is not ours, and the sweep (rightly) refuses
    // to treat a denied tag read as "not ours" — so it never completed.
    expect(actionsOf('RelayPurgeAcmDiscover').sort()).toEqual(
      ['acm:ListCertificates', 'acm:ListTagsForCertificate'].sort(),
    );
    expect(findBySid('RelayPurgeAcmDiscover')?.['Condition']).toBeUndefined();

    // The same grants sit inside the permissions boundary (the ceiling) —
    // matched by action, since the boundary carries no statement ids.
    const boundary = collectActions(stack.permissionsBoundary.document.toJSON()['Statement']);
    for (const sid of [
      'RelayPurgeRdsDiscover',
      'RelayPurgeSecretsList',
      'RelayPurgeSecretsDelete',
      'RelayPurgeAcmDiscover',
    ]) {
      for (const action of actionsOf(sid)) expect(boundary).toContain(action);
    }
  });

  it('carries the RelayCredential NoEcho parameter (DZ-AUDIT-013) alongside the existing public params', () => {
    const { template } = synth();
    const json = template.toJSON();
    const params = (json['Parameters'] ?? {}) as Record<string, Record<string, unknown>>;

    // CDK synthesizes a synthetic BootstrapVersion parameter (not a secret).
    const names = Object.keys(params);
    expect(names).toContain('BootstrapVersion');
    const appParams = Object.fromEntries(
      Object.entries(params).filter(([name]) => name !== 'BootstrapVersion'),
    );

    // RelayCredential is the one NoEcho parameter — allowing it is the
    // DZ-AUDIT-013 change; the rest stay non-secret.
    for (const [name, param] of Object.entries(appParams)) {
      if (name === 'RelayCredential') {
        expect(param['NoEcho'], 'RelayCredential must be NoEcho').toBe(true);
        expect(param['Type']).toBe('String');
        expect(param['Default']).toBe('');
      } else {
        expect(param['NoEcho'], `parameter ${name} must not be NoEcho`).not.toBe(true);
        expect(['ControlPlaneUrl', 'EnrollmentCode', 'ApplicationTemplateUrl', 'CustomerScope']).toContain(
          name,
        );
      }
    }
    expect(Object.keys(appParams).sort()).toEqual([
      'ApplicationTemplateUrl',
      'ControlPlaneUrl',
      'CustomerScope',
      'EnrollmentCode',
      'RelayCredential',
    ]);
  });

  it('declares the CustomerScope parameter, defaulting to the inert sentinel "none", and threads it into the relay environment (regional HTTPS certificates)', () => {
    const { template } = synth();
    const json = template.toJSON();
    const params = (json['Parameters'] ?? {}) as Record<string, Record<string, unknown>>;

    // 'none' — not '' — because a real scope is 12 lowercase hex characters
    // and can never equal it, so an installation left at the default is
    // inert for ProvisionerRegionalAcmManage without a CfnCondition/Fn::If.
    expect(params['CustomerScope']).toMatchObject({
      Type: 'String',
      Default: 'none',
    });
    expect(params['CustomerScope']?.['AllowedPattern']).toBe('^[a-z0-9]{0,32}$');

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DEPLOYZ_CUSTOMER_SCOPE: { Ref: 'CustomerScope' },
        }),
      }),
    });
  });

  it('publishes plain stack outputs with no Export blocks', () => {
    const { template } = synth();
    const outputs = (template.toJSON()['Outputs'] ?? {}) as Record<
      string,
      Record<string, unknown>
    >;

    // The template is synthesized once and deployed many times per account:
    // a fixed export name would collide across deployments and roll the
    // second stack back. Plain outputs keep the DescribeStacks handshake.
    for (const [name, output] of Object.entries(outputs)) {
      expect(output['Export'], `output ${name} must not be an export`).toBeUndefined();
    }
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining([
        'RelayFunctionArn',
        'CredentialSecretArn',
        'ProvisionerPolicyArn',
        'InstallationId',
        'ApplicationExecutionRoleArn',
      ]),
    );
  });

  it('tells the relay its own deployed bootstrap stack name', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          // Ref AWS::StackName — the DEPLOYED name, not a synth-time literal.
          DEPLOYZ_BOOTSTRAP_STACK_NAME: { Ref: 'AWS::StackName' },
        }),
      }),
    });
  });

  it('lets the relay read its own application stack', () => {
    const template = Template.fromStack(new BootstrapStack(new App(), 'TestStack'));

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'RelayVerifyInstallation',
            Effect: 'Allow',
            Action: [
              'cloudformation:DescribeStacks',
              'cloudformation:DescribeStackResources',
              'cloudformation:ListStackResources',
            ],
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

it('creates two mutually exclusive credential secrets with conditions (DZ-AUDIT-013)', () => {
    const { template } = synth();
    const resources = allResources(template);

    const secrets = Object.entries(resources).filter(
      ([, r]) => r.Type === 'AWS::SecretsManager::Secret',
    );

    // Two CfnSecrets: one from parameter (HasRelayCredential), one generated (NoRelayCredential).
    expect(secrets).toHaveLength(2);

    for (const [, resource] of secrets) {
      expect(resource.Properties?.['Tags']).toEqual(
        expect.arrayContaining([{ Key: 'deployz:component', Value: 'bootstrap' }]),
      );
      if (resource.Properties?.['SecretString'] !== undefined) {
        expect(resource.Properties!['GenerateSecretString']).toBeUndefined();
      } else {
        expect(resource.Properties!['GenerateSecretString']).toBeDefined();
      }
    }

    // Conditions present in the Conditions section.
    const json = template.toJSON();
    const conditions = json['Conditions'] as Record<string, unknown> | undefined;
    expect(conditions).toBeDefined();
    expect(conditions!['HasRelayCredential']).toBeDefined();
    expect(conditions!['NoRelayCredential']).toBeDefined();
  });

  it('the credential secret ARN in the relay Lambda env uses Fn::If (DZ-AUDIT-013)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DEPLOYZ_CREDENTIAL_SECRET_ARN: { 'Fn::If': Match.anyValue() },
        }),
      },
    });
  });

  it('the CredentialSecretArn output uses Fn::If (DZ-AUDIT-013)', () => {
    const { template } = synth();
    const outputs = (template.toJSON()['Outputs'] ?? {}) as Record<string, Record<string, unknown>>;
    const credOutput = outputs['CredentialSecretArn'];
    expect(credOutput).toBeDefined();
    const value = credOutput!['Value'] as Record<string, unknown>;
    expect(value).toBeDefined();
    expect(value['Fn::If']).toBeDefined();
  });

  it('creates the HasRelayCredential and NoRelayCredential conditions (DZ-AUDIT-013)', () => {
    const { template } = synth();
    const json = template.toJSON();
    const conditions = json['Conditions'] as Record<string, unknown>;
    expect(conditions).toBeDefined();
    expect(conditions!['HasRelayCredential']).toBeDefined();
    expect(conditions!['NoRelayCredential']).toBeDefined();
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
      'elasticache:CreateReplicationGroup',
      'cloudwatch:PutMetricAlarm',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('grants the execution role replication-group lifecycle actions condition-free', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    // Live-proven multi-resource auth traps (see PROVISION_UNTAGGABLE_ACTIONS):
    // CreateReplicationGroup is also evaluated against the untagged default
    // parameter group, and rollback's DeleteReplicationGroup runs against a
    // replication group that never received its tag-on-create. A tag
    // condition on either wedges the stack — these must sit in the
    // condition-free statement, and must no longer ride in the tagged
    // create/manage buckets. DeleteCacheCluster rides along condition-free
    // too, kept for stacks created before the ReplicationGroup switch.
    for (const action of [
      'elasticache:CreateReplicationGroup',
      'elasticache:ModifyReplicationGroup',
      'elasticache:DeleteReplicationGroup',
      'elasticache:DeleteCacheCluster',
    ]) {
      const granting = statements.filter((s) => collectActions([s]).includes(action));
      expect(granting).toHaveLength(1);
      expect(granting[0]?.['Condition']).toBeUndefined();
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

  it('scopes the execution role alarm creation to this installation tag', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const creating = statements.find((s) =>
      collectActions([s]).includes('cloudwatch:PutMetricAlarm'),
    );
    const condition = JSON.stringify(creating?.['Condition']);

    expect(condition).toContain('aws:RequestTag/deployz:installation');
  });

  it('scopes the execution role alarm deletes to resources already carrying the tag', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const deleting = statements.find((s) =>
      collectActions([s]).includes('cloudwatch:DeleteAlarms'),
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
    for (const action of collectActions(stack.provisionerPurgePolicy.document.toJSON()['Statement'])) {
      expect(boundary).toContain(action);
    }
  });

  // IAM refuses a managed policy over 6,144 non-whitespace characters, and
  // CloudFormation reports it as a failed CreateStack for every new install
  // ("Cannot exceed quota for PolicySize") — seen live once the purge sweeps
  // pushed the boundary to 6,350, and again once the regional-certificate
  // grant pushed the (Sid-carrying) provisioner policy over on its own,
  // which is why the purge/discovery statements now live in their own
  // ProvisionerPurgePolicy. Measured on the synthesized template, the same
  // document CloudFormation submits — covers all three managed policies
  // (PermissionsBoundary, ProvisionerPolicy, ProvisionerPurgePolicy)
  // generically, so a fourth split would be covered too.
  it('keeps all three managed policies under the IAM policy-size quota', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::ManagedPolicy');
    expect(Object.keys(policies).length).toBeGreaterThanOrEqual(3);
    for (const [logicalId, resource] of Object.entries(policies)) {
      const size = JSON.stringify(resource['Properties']?.['PolicyDocument']).replace(/\s/g, '').length;
      expect(size, `${logicalId} policy document is ${size} chars`).toBeLessThan(IAM_MANAGED_POLICY_MAX_CHARS);
    }
  });

  it('carries the same grants in the boundary as in the union of both provisioner policies, without statement ids', () => {
    const { stack } = synth();
    const boundaryStatements = stack.permissionsBoundary.document.toJSON()['Statement'] as Record<string, unknown>[];
    expect(boundaryStatements.every((s) => s['Sid'] === undefined)).toBe(true);
    const provisionerStatements = stack.provisionerPolicy.document.toJSON()['Statement'] as Record<string, unknown>[];
    const provisionerPurgeStatements = stack.provisionerPurgePolicy.document.toJSON()[
      'Statement'
    ] as Record<string, unknown>[];
    expect(provisionerStatements.every((s) => typeof s['Sid'] === 'string')).toBe(true);
    expect(provisionerPurgeStatements.every((s) => typeof s['Sid'] === 'string')).toBe(true);
    // The split is purely for the size quota — the boundary must still carry
    // the union of both provisioner policies' grants.
    expect(collectActions(boundaryStatements)).toEqual(
      expect.arrayContaining(
        collectActions([...provisionerStatements, ...provisionerPurgeStatements]),
      ),
    );
  });
});

describe('BootstrapStack — the relay credential secret ARN', () => {
  /**
   * Ref on an AWS::SecretsManager::Secret returns the ARN; the type has no
   * `Arn` attribute. A Fn::GetAtt makes CloudFormation reject the whole
   * template — "Requested attribute Arn does not exist in schema for
   * AWS::SecretsManager::Secret" — so the first stack a customer deploys
   * fails and no install can succeed (found on real AWS, 2026-09-10).
   */
  it('never reads an Arn attribute off a SecretsManager secret', () => {
    const { template } = synth();
    const secretIds = Object.entries(template.toJSON().Resources as Record<string, { Type: string }>)
      .filter(([, resource]) => resource.Type === 'AWS::SecretsManager::Secret')
      .map(([logicalId]) => logicalId);
    expect(secretIds.length).toBeGreaterThan(0);

    const badAttributes: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'Fn::GetAtt' && Array.isArray(value) && secretIds.includes(String(value[0]))) {
          badAttributes.push(`${String(value[0])}.${String(value[1])}`);
        }
        walk(value);
      }
    };
    walk(template.toJSON());
    expect(badAttributes).toEqual([]);
  });

  it('resolves the credential ARN by Ref through the condition', () => {
    const { template } = synth();
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('"Ref":"RelayCredentialFromParam"');
    expect(json).toContain('"Ref":"RelayCredentialGenerated"');
  });
});

describe('BootstrapStack — the relay credential secret value', () => {
  /**
   * The relay reads this secret as JSON and takes its `token` field
   * (packages/relay/src/auth.ts, readCredential). Both variants must
   * therefore hold `{"token": "..."}`. Storing the server-established
   * parameter bare made every relay poll fail with
   * "relay:credential-read-failed ... Unexpected non-whitespace character
   * after JSON", so the installation never enrolled and the deployment sat
   * in WAITING_FOR_RELAY (found on real AWS, 2026-09-10).
   */
  it('wraps the server-established credential as JSON so the relay can parse it', () => {
    const { template } = synth();
    const secret = (template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>)[
      'RelayCredentialFromParam'
    ];
    expect(secret?.Type).toBe('AWS::SecretsManager::Secret');

    const secretString = secret?.Properties?.['SecretString'];
    // Never the bare parameter — that is the shape the relay cannot parse.
    expect(secretString).not.toEqual({ Ref: 'RelayCredential' });

    const parts = (secretString as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join']?.[1];
    expect(parts).toEqual(['{"token":"', { Ref: 'RelayCredential' }, '"}']);
  });

  it('generates the other variant with the same token field', () => {
    const { template } = synth();
    const secret = (template.toJSON().Resources as Record<string, { Properties?: Record<string, unknown> }>)[
      'RelayCredentialGenerated'
    ];
    const generate = secret?.Properties?.['GenerateSecretString'] as Record<string, unknown> | undefined;
    expect(generate?.['GenerateStringKey']).toBe('token');
    expect(generate?.['SecretStringTemplate']).toBe('{}');
  });
});

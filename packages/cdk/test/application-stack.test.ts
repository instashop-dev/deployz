import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  ApplicationStack,
  type ApplicationStackProps,
} from '../src/application/application-stack.js';
import { DOCUMENSO_APPLICATION_PROPS } from '../src/application/documenso.js';
import { DOCUMENSO_PARAMETERS } from '@deployz/contracts';

import { withStableAssetHashes } from './stable-template.js';

function synth(expressMode = false, extraProps: Partial<ApplicationStackProps> = {}) {
  const app = new App();
  const stack = new ApplicationStack(app, 'ApplicationTest', {
    expressMode,
    // Tests default to the explicit insecure-HTTP opt-in so existing
    // fixtures don't need a certificate; the opt-in requirement itself is
    // covered by its own tests below.
    allowInsecureHttp: true,
    ...extraProps,
  });
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

type TemplateResource = { Type: string; Properties?: Record<string, unknown> };

function allResources(template: Template): Record<string, TemplateResource> {
  return (template.toJSON() as { Resources: Record<string, TemplateResource> })['Resources'];
}

/** Parameters excluding the CDK-synthetic BootstrapVersion parameter. */
function appParameters(template: Template): Record<string, Record<string, unknown>> {
  const params = (template.toJSON() as { Parameters?: Record<string, Record<string, unknown>> })[
    'Parameters'
  ];
  return Object.fromEntries(
    Object.entries(params ?? {}).filter(([name]) => name !== 'BootstrapVersion'),
  );
}

/**
 * Resource types that carry a `deployz:component` tag via Tags.of(this).
 * Non-taggable CloudFormation types (Route/RouteTableAssociation/
 * VPCGatewayAttachment/SecretTargetAttachment/BucketPolicy/SecurityGroup
 * Ingress+Egress) and CDK inline IAM Policies are intentionally excluded.
 */
const TAGGABLE_TYPES = [
  'AWS::EC2::VPC',
  'AWS::EC2::Subnet',
  'AWS::EC2::RouteTable',
  'AWS::EC2::EIP',
  'AWS::EC2::NatGateway',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::SecurityGroup',
  'AWS::ECS::Cluster',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBSubnetGroup',
  'AWS::S3::Bucket',
  'AWS::SecretsManager::Secret',
  'AWS::Logs::LogGroup',
  'AWS::IAM::Role',
  'AWS::ElastiCache::ReplicationGroup',
  'AWS::ElastiCache::SubnetGroup',
] as const;

describe('ApplicationStack', () => {
  it('synthesizes without errors (plain Fargate)', () => {
    const { template } = synth(false);
    expect(template).toBeDefined();
  });

  it('creates a baseline unhealthy-target CloudWatch alarm on the app target group', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'UnHealthyHostCount',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      Period: 60,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      TreatMissingData: 'notBreaching',
    });
  });

  it('synthesizes without errors (Express mode)', () => {
    const { template } = synth(true);
    expect(template).toBeDefined();
  });

  it('creates a VPC with 2 AZs (public + private subnets, NAT gateway)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::Subnet', 4); // 2 AZs x (public + private)
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  it('creates an RDS PostgreSQL instance (db.t4g.micro, Postgres 16, encrypted, backups)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBInstanceClass: 'db.t4g.micro',
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
    });
  });

  it('generates the DB password (never a template parameter)', () => {
    const { template } = synth();
    // The DB master credential is bootstrap-generated via GenerateSecretString,
    // NOT supplied as a template parameter.
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: 'password',
      }),
    });
    // No parameter carries a database credential.
    for (const [name, param] of Object.entries(appParameters(template))) {
      expect(name.toLowerCase(), `parameter ${name} looks like a DB credential`).not.toMatch(
        /password|database|dbuser|db_pass/,
      );
      expect(param['NoEcho']).toBe(true);
    }
  });

  it('generates a DB password that is safe both for RDS and for a postgresql:// URL', () => {
    const { template } = synth();

    // RDS rejects a MasterUserPassword containing '/', '@', '"' or a space —
    // a live install failed on exactly this and rolled the whole stack back.
    // The password is also embedded verbatim in a postgresql:// URL (the
    // DatabaseUrlSecret below) via a CloudFormation dynamic reference, where
    // percent-encoding cannot happen — so it must be alphanumeric only,
    // which is a strict superset of the four RDS-forbidden characters.
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const dbSecret = Object.values(secrets).find((resource) =>
      String(resource['Properties']?.['Description'] ?? '').includes('RDS'),
    );

    expect(dbSecret?.['Properties']?.['GenerateSecretString']?.['ExcludePunctuation']).toBe(true);
    expect(
      dbSecret?.['Properties']?.['GenerateSecretString']?.['ExcludeCharacters'],
    ).toBeUndefined();
  });

  it('runs tasks under the execution role that can pull the image', () => {
    const { template } = synth();

    // The stack builds a TaskExecutionRole carrying
    // AmazonECSTaskExecutionRolePolicy — the grant that includes
    // ecr:GetAuthorizationToken. In plain-Fargate mode that role used to be
    // created and then never wired up: CDK auto-generated a second
    // execution role for the task definition, and because the image is a
    // plain registry string CDK could not tell it was ECR and granted no
    // pull permissions. A live install got all the way to the ECS service
    // and stalled there, unable to pull its own image.
    const roles = template.findResources('AWS::IAM::Role');
    const withEcsExecutionPolicy = Object.entries(roles).filter(([, role]) =>
      JSON.stringify(role['Properties']?.['ManagedPolicyArns'] ?? '').includes(
        'AmazonECSTaskExecutionRolePolicy',
      ),
    );
    expect(withEcsExecutionPolicy).toHaveLength(1);
    const [executionRoleId] = withEcsExecutionPolicy[0]!;

    const taskDefinitions = template.findResources('AWS::ECS::TaskDefinition');
    expect(Object.keys(taskDefinitions).length).toBeGreaterThan(0);
    for (const [id, definition] of Object.entries(taskDefinitions)) {
      expect(
        JSON.stringify(definition['Properties']?.['ExecutionRoleArn'] ?? ''),
        `${id} must run under the execution role that can pull the image`,
      ).toContain(executionRoleId);
    }
  });

  it('creates a versioned S3 bucket for object storage', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('creates a CloudWatch log group with retention', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 7,
    });
  });

  describe('ECS deployment model (C3/U3)', () => {
    it('uses plain Fargate (ALB + service + task definition) by default', () => {
      const { template } = synth(false);
      template.resourceCountIs('AWS::ECS::ExpressGatewayService', 0);
      template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
      template.resourceCountIs('AWS::ECS::Service', 1);
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
      // Internet-facing ALB with a /health target-group health check.
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Scheme: 'internet-facing',
      });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: { Ref: 'paramHealthCheckPath' },
      });
    });

    it('uses ECS Express Mode when expressMode is true', () => {
      const { template } = synth(true);
      template.resourceCountIs('AWS::ECS::ExpressGatewayService', 1);
      // Express mode manages its own ALB/target group/security groups — no
      // explicit load balancer is provisioned by the stack.
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
      template.resourceCountIs('AWS::ECS::TaskDefinition', 0);
      template.resourceCountIs('AWS::ECS::Service', 0);
      template.hasResourceProperties('AWS::ECS::ExpressGatewayService', {
        HealthCheckPath: { Ref: 'paramHealthCheckPath' },
        Cpu: '256',
        Memory: '512',
      });
    });
  });

  it('tags every taggable resource with deployz:component=application', () => {
    const { template } = synth();
    for (const type of TAGGABLE_TYPES) {
      const resources = template.findResources(type) as Record<
        string,
        { Properties?: Record<string, unknown> }
      >;
      for (const [logicalId, resource] of Object.entries(resources)) {
        const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
        const component = tags.find((t) => t['Key'] === 'deployz:component');
        expect(component?.['Value'], `${type} ${logicalId}`).toBe('application');
      }
    }
  });

  it('never echoes a secret parameter (NoEcho + param_ prefix)', () => {
    const { template } = synth();
    const params = appParameters(template);
    const names = Object.keys(params);

    // The only application parameters are the two app-env secrets and the
    // health path override.
    expect(names.sort()).toEqual(
      ['paramAppApiKey', 'paramAppSigningSecret', 'paramHealthCheckPath'].sort(),
    );

    for (const [name, param] of Object.entries(params)) {
      // `param_` naming prefix — CDK/CloudFormation strip the underscore from
      // the logical ID, leaving a `param`-prefixed name.
      expect(name, `parameter ${name} must use the param_ prefix`).toMatch(/^param[A-Z]/);
      // NoEcho — the value is never echoed back to the console or API.
      expect(param['NoEcho'], `parameter ${name} must be NoEcho`).toBe(true);
    }

    // Strongest form: every non-synthetic parameter is NoEcho — there is no
    // echoable parameter anywhere in the template.
    const nonSynthetic = (template.toJSON() as {
      Parameters: Record<string, Record<string, unknown>>;
    })['Parameters'];
    for (const [name, param] of Object.entries(nonSynthetic)) {
      if (name === 'BootstrapVersion') continue;
      expect(param['NoEcho'], `parameter ${name} must be NoEcho`).toBe(true);
    }
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
        'DbHost',
        'DbSecretArn',
        'StorageBucketName',
        'ClusterName',
        'PublicEndpoint',
      ]),
    );
  });

  it('opens the load balancer on 443 even with no certificate at synth time', () => {
    // A custom domain is attached AFTER install: the relay adds the HTTPS
    // listener over the ELBv2 API, which cannot open the load balancer's
    // security group. Unless 443 is already open, that listener is
    // unreachable and the domain never leaves CONFIGURING.
    const { template } = synth();

    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 443, ToPort: 443, IpProtocol: 'tcp' }),
      ]),
    });
  });

  it('matches the committed snapshot (plain Fargate)', () => {
    const { template } = synth(false);
    expect(withStableAssetHashes(template.toJSON())).toMatchSnapshot();
  });

  describe('worker + expressMode validation (§8.1)', () => {
    it('throws a clear synth-time error when expressMode and workerCommand are both set', () => {
      const app = new App();
      expect(
        () =>
          new ApplicationStack(app, 'InvalidWorkerExpress', {
            expressMode: true,
            workerCommand: 'node worker.js',
            allowInsecureHttp: true,
          }),
      ).toThrow(/workerCommand is not supported when expressMode is true/);
    });

    it('does not throw when workerCommand is set without expressMode', () => {
      expect(() => synth(false, { workerCommand: 'node worker.js' })).not.toThrow();
    });

    it('does not throw when expressMode is set without workerCommand', () => {
      expect(() => synth(true)).not.toThrow();
    });
  });

  describe('HTTPS endpoint contract (§9/§11)', () => {
    it('throws when no certificateArn and no explicit insecure opt-in', () => {
      const app = new App();
      expect(() => new ApplicationStack(app, 'InvalidNoCert', {})).toThrow(
        /certificateArn is required for a public HTTPS endpoint/,
      );
    });

    it('does not throw when allowInsecureHttp is explicitly true', () => {
      expect(() => synth(false, { allowInsecureHttp: true, certificateArn: undefined })).not.toThrow();
    });

    it('creates an HTTP:80 listener with no HTTPS listener when allowInsecureHttp is set', () => {
      const { template } = synth(false);
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        Protocol: 'HTTP',
      });
    });

    it('creates an HTTPS:443 listener + HTTP:80 redirect when certificateArn is supplied', () => {
      const { template } = synth(false, {
        allowInsecureHttp: false,
        certificateArn:
          'arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111',
      });
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        Protocol: 'HTTPS',
        Certificates: [
          {
            CertificateArn:
              'arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111',
          },
        ],
      });
      // HTTP:80 redirects to HTTPS rather than serving the app directly.
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [
          Match.objectLike({
            Type: 'redirect',
            RedirectConfig: Match.objectLike({ Protocol: 'HTTPS', Port: '443' }),
          }),
        ],
      });
    });
  });

  describe('deployz:installation tag (§15)', () => {
    it('applies deployz:installation to taggable resources when installationId is supplied', () => {
      const { template } = synth(false, { installationId: 'inst-abc123' });
      for (const type of TAGGABLE_TYPES) {
        const resources = template.findResources(type) as Record<
          string,
          { Properties?: Record<string, unknown> }
        >;
        for (const [logicalId, resource] of Object.entries(resources)) {
          const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
          const installation = tags.find((t) => t['Key'] === 'deployz:installation');
          expect(installation?.['Value'], `${type} ${logicalId}`).toBe('inst-abc123');
        }
      }
    });

    it('omits deployz:installation entirely when installationId is not supplied', () => {
      const { template } = synth(false);
      for (const type of TAGGABLE_TYPES) {
        const resources = template.findResources(type) as Record<
          string,
          { Properties?: Record<string, unknown> }
        >;
        for (const resource of Object.values(resources)) {
          const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
          expect(tags.some((t) => t['Key'] === 'deployz:installation')).toBe(false);
        }
      }
    });
  });

  describe('No-database mode (databaseRequired: false)', () => {
    it('provisions zero RDS resources and no DB security group', () => {
      const { template } = synth(false, { databaseRequired: false });
      template.resourceCountIs('AWS::RDS::DBInstance', 0);
      template.resourceCountIs('AWS::RDS::DBSubnetGroup', 0);
      // No DbSecurityGroup resource — the DB ingress SG only exists with RDS.
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('DbSecurityGroup');
    });

    it('injects no DATABASE_* container env vars or secrets', () => {
      const { template } = synth(false, { databaseRequired: false });
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('DATABASE_HOST');
      expect(json).not.toContain('DATABASE_PORT');
      expect(json).not.toContain('DATABASE_NAME');
      expect(json).not.toContain('DATABASE_USER');
      expect(json).not.toContain('DATABASE_PASSWORD');
    });

    it('omits the DB stack outputs (DbHost / DbSecretArn)', () => {
      const { template } = synth(false, { databaseRequired: false });
      const outputs = Object.keys(template.findOutputs('*'));
      expect(outputs).not.toContain('DbHost');
      expect(outputs).not.toContain('DbSecretArn');
      // Non-DB outputs are unaffected.
      expect(outputs).toContain('StorageBucketName');
      expect(outputs).toContain('PublicEndpoint');
    });

    it('omits the generated DB-password secret', () => {
      const { template } = synth(false, { databaseRequired: false });
      // No SecretsManager secret carries a generated DB password.
      const secrets = template.findResources('AWS::SecretsManager::Secret') as Record<
        string,
        { Properties?: { GenerateSecretString?: Record<string, unknown> } }
      >;
      for (const [, secret] of Object.entries(secrets)) {
        expect(secret.Properties?.GenerateSecretString?.['GenerateStringKey']).not.toBe(
          'password',
        );
      }
    });

    it('synthesizes without errors in Express mode without a database', () => {
      const { template } = synth(true, { databaseRequired: false });
      template.resourceCountIs('AWS::RDS::DBInstance', 0);
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('DATABASE_HOST');
      expect(json).not.toContain('DATABASE_PASSWORD');
    });

    it('defaults to provisioning RDS when databaseRequired is unset (no regression)', () => {
      const { template } = synth();
      template.resourceCountIs('AWS::RDS::DBInstance', 1);
      const outputs = Object.keys(template.findOutputs('*'));
      expect(outputs).toContain('DbHost');
      expect(outputs).toContain('DbSecretArn');
    });
  });

  describe('databaseUrlEnvNames validation', () => {
    it('throws a clear synth-time error when databaseUrlEnvNames is non-empty with databaseRequired: false', () => {
      const app = new App();
      expect(
        () =>
          new ApplicationStack(app, 'InvalidDatabaseUrl', {
            databaseRequired: false,
            databaseUrlEnvNames: ['DATABASE_URL'],
            allowInsecureHttp: true,
          }),
      ).toThrow(/databaseUrlEnvNames/);
    });
  });

  describe('ElastiCache Valkey cache (Redis MVP)', () => {
    it('provisions zero ElastiCache resources and no REDIS env vars when redisRequired is unset', () => {
      const { template } = synth();
      template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 0);
      template.resourceCountIs('AWS::ElastiCache::SubnetGroup', 0);
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('REDIS_URL');
      expect(json).not.toContain('REDIS_HOST');
      expect(json).not.toContain('REDIS_PORT');
    });

    it('provisions a single-node Valkey cache over the private subnets when redisRequired is true', () => {
      const { template } = synth(false, { redisRequired: true });
      template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        Engine: 'valkey',
        CacheNodeType: 'cache.t4g.micro',
        NumCacheClusters: 1,
        AutomaticFailoverEnabled: false,
        MultiAZEnabled: false,
        Port: 6379,
      });
      template.resourceCountIs('AWS::ElastiCache::SubnetGroup', 1);
      // No hardcoded ReplicationGroupId — CFN logical-ID naming keeps it
      // deterministic per stack without hitting ElastiCache's name-length
      // limits.
      const [replicationGroup] = Object.values(
        template.findResources('AWS::ElastiCache::ReplicationGroup'),
      ) as Array<{ Properties?: Record<string, unknown> }>;
      expect(replicationGroup?.Properties?.['ReplicationGroupId']).toBeUndefined();
    });

    it('opens ingress on tcp/6379 from the VPC CIDR block only — never 0.0.0.0/0 (same broad-VPC pattern as RDS)', () => {
      const { template } = synth(false, { redisRequired: true });
      // Resolve the VPC's own logical id dynamically rather than hardcoding
      // the CDK-generated hash suffix, so this test doesn't silently stop
      // checking anything if the construct tree shifts.
      const [vpcLogicalId] = Object.keys(template.findResources('AWS::EC2::VPC'));
      expect(vpcLogicalId).toBeDefined();

      // A CIDR-peer ingress rule (as opposed to an SG-to-SG rule) is emitted
      // inline on the security group resource itself, not as a separate
      // AWS::EC2::SecurityGroupIngress resource — same as dbSecurityGroup.
      // Pin CidrIp to an Fn::GetAtt on the VPC's own CidrBlock — the whole
      // point of this security group is to scope ingress to the VPC, never
      // to the public internet (0.0.0.0/0).
      template.hasResourceProperties(
        'AWS::EC2::SecurityGroup',
        Match.objectLike({
          SecurityGroupIngress: Match.arrayWith([
            Match.objectLike({
              IpProtocol: 'tcp',
              FromPort: 6379,
              ToPort: 6379,
              CidrIp: { 'Fn::GetAtt': [vpcLogicalId, 'CidrBlock'] },
            }),
          ]),
        }),
      );

      // Belt-and-suspenders: no security group in this stack opens 6379 to
      // the whole internet.
      const securityGroups = template.findResources('AWS::EC2::SecurityGroup') as Record<
        string,
        { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } }
      >;
      for (const [logicalId, resource] of Object.entries(securityGroups)) {
        const rules = resource.Properties?.SecurityGroupIngress ?? [];
        for (const rule of rules) {
          if (rule['FromPort'] === 6379 && rule['ToPort'] === 6379) {
            expect(rule['CidrIp'], `${logicalId} 6379 ingress`).not.toBe('0.0.0.0/0');
          }
        }
      }
    });

    // The endpoint address is an unresolved CFN token at synth time, so a
    // `redis://${address}:6379` binding becomes an Fn::Join intrinsic in the
    // synthesized template rather than a plain string — assert on its parts
    // instead of a literal regex match against Value.
    function expectRedisUrlJoin(value: unknown) {
      expect(value).toMatchObject({
        'Fn::Join': ['', expect.arrayContaining(['redis://', ':6379'])],
      });
    }

    it('injects default REDIS_URL/REDIS_HOST/REDIS_PORT container env in plain Fargate mode', () => {
      const { template } = synth(false, { redisRequired: true });
      const [taskDef] = Object.values(
        template.findResources('AWS::ECS::TaskDefinition'),
      ) as Array<{ Properties: { ContainerDefinitions: Array<{ Environment: Array<{ Name: string; Value: unknown }> }> } }>;
      const env = taskDef.Properties.ContainerDefinitions[0].Environment;
      const byName = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining(['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT']),
      );
      expectRedisUrlJoin(byName['REDIS_URL']);
      expect(byName['REDIS_PORT']).toBe('6379');
    });

    it('injects default REDIS_* container env in Express mode', () => {
      const { template } = synth(true, { redisRequired: true });
      const [expressService] = Object.values(
        template.findResources('AWS::ECS::ExpressGatewayService'),
      ) as Array<{
        Properties: { PrimaryContainer: { Environment: Array<{ Name: string; Value: unknown }> } };
      }>;
      const env = expressService.Properties.PrimaryContainer.Environment;
      const byName = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining(['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT']),
      );
      expectRedisUrlJoin(byName['REDIS_URL']);
      expect(byName['REDIS_PORT']).toBe('6379');
    });

    it('injects the worker task with the same REDIS_* container env as the app task', () => {
      const { template } = synth(false, {
        redisRequired: true,
        workerCommand: 'node worker.js',
      });
      const taskDefs = Object.values(
        template.findResources('AWS::ECS::TaskDefinition'),
      ) as Array<{ Properties?: { ContainerDefinitions?: Array<{ Environment?: unknown }> } }>;
      expect(taskDefs).toHaveLength(2);
      for (const taskDef of taskDefs) {
        const env = (taskDef.Properties?.ContainerDefinitions?.[0]?.Environment ??
          []) as Array<Record<string, unknown>>;
        const names = env.map((e) => e['Name']);
        expect(names).toEqual(expect.arrayContaining(['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT']));
      }
    });

    it('resolves detected connectionEnvVars (e.g. CELERY_BROKER_URL) into a redis:// URL binding', () => {
      const { template } = synth(false, {
        redisRequired: true,
        redisEnvVars: ['CELERY_BROKER_URL'],
      });
      const [taskDef] = Object.values(
        template.findResources('AWS::ECS::TaskDefinition'),
      ) as Array<{ Properties: { ContainerDefinitions: Array<{ Environment: Array<{ Name: string; Value: unknown }> }> } }>;
      const env = taskDef.Properties.ContainerDefinitions[0].Environment;
      const byName = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
      expect(Object.keys(byName)).toContain('CELERY_BROKER_URL');
      // Only the one requested binding is injected — not the three defaults.
      expect(Object.keys(byName)).not.toContain('REDIS_URL');
      expectRedisUrlJoin(byName['CELERY_BROKER_URL']);
    });

    it('tags every ElastiCache resource with all four deployz:* tags', () => {
      const { template } = synth(false, {
        redisRequired: true,
        applicationId: 'app-1',
        vendorId: 'vendor-1',
        installationId: 'inst-1',
      });
      for (const type of ['AWS::ElastiCache::ReplicationGroup', 'AWS::ElastiCache::SubnetGroup']) {
        const resources = template.findResources(type) as Record<
          string,
          { Properties?: Record<string, unknown> }
        >;
        expect(Object.keys(resources).length).toBeGreaterThan(0);
        for (const [logicalId, resource] of Object.entries(resources)) {
          const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
          const byKey = Object.fromEntries(tags.map((t) => [t['Key'], t['Value']]));
          expect(byKey['deployz:component'], `${type} ${logicalId}`).toBe('application');
          expect(byKey['deployz:application'], `${type} ${logicalId}`).toBe('app-1');
          expect(byKey['deployz:vendor'], `${type} ${logicalId}`).toBe('vendor-1');
          expect(byKey['deployz:installation'], `${type} ${logicalId}`).toBe('inst-1');
        }
      }
      // The dedicated redis security group is also tagged (it's an
      // AWS::EC2::SecurityGroup, already covered by TAGGABLE_TYPES elsewhere,
      // but assert directly here for the redis-specific SG among the set).
      const securityGroups = template.findResources('AWS::EC2::SecurityGroup') as Record<
        string,
        { Properties?: Record<string, unknown> }
      >;
      const redisSg = Object.entries(securityGroups).find(([logicalId]) =>
        logicalId.includes('Redis'),
      );
      expect(redisSg, 'expected a Redis security group logical id').toBeDefined();
    });

    it('publishes the cache endpoint output', () => {
      const { template } = synth(false, { redisRequired: true });
      const outputs = Object.keys(template.findOutputs('*'));
      expect(outputs).toContain('CacheEndpoint');
    });

    it('omits the cache endpoint output when redisRequired is unset', () => {
      const { template } = synth();
      const outputs = Object.keys(template.findOutputs('*'));
      expect(outputs).not.toContain('CacheEndpoint');
    });
  });

  describe('Configurable container contract', () => {
    it('applies containerPort/healthCheckPath to the task definition and target group (HTTP branch)', () => {
      const { template } = synth(false, { containerPort: 4000, healthCheckPath: '/api/health' });

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: { Ref: 'paramHealthCheckPath' },
        Port: 4000,
      });
      // The curl command interpolates the parameter, so CDK renders it as a
      // Join over the Ref rather than a plain string.
      const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
      const serialized = JSON.stringify(taskDefs);
      expect(serialized).toContain('"Ref":"paramHealthCheckPath"');
      expect(serialized).toContain('http://localhost:4000');
    });

    it('applies containerPort/healthCheckPath to the target group in the HTTPS branch too', () => {
      const { template } = synth(false, {
        containerPort: 4000,
        healthCheckPath: '/api/health',
        certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/test',
      });

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: { Ref: 'paramHealthCheckPath' },
        Port: 4000,
      });
    });

    it('defaults the health path parameter to the prop value and lets an install override it', () => {
      const { template } = synth(false, { healthCheckPath: '/api/health' });
      const params = appParameters(template);
      expect(params['paramHealthCheckPath']).toMatchObject({ NoEcho: true, Default: '/api/health' });
    });

    it('injects containerEnvironment into the App container', () => {
      const { template } = synth(false, { containerEnvironment: { FOO: 'bar' } });

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Environment: Match.arrayWith([{ Name: 'FOO', Value: 'bar' }]),
          }),
        ]),
      });
    });

    it('creates a NoEcho param_ parameter and wires an ECS secret for each secretParameters entry', () => {
      const { template } = synth(false, {
        secretParameters: [
          { parameterId: 'param_TestSecret', secretKey: 'testSecret', envName: 'TEST_SECRET' },
        ],
      });

      const params = appParameters(template);
      expect(params['paramTestSecret']).toMatchObject({ NoEcho: true, Default: '' });

      // appSecret's SecretString references the new parameter under its
      // secretKey — same Fn::Join pattern as the two built-in secrets.
      template.hasResourceProperties('AWS::SecretsManager::Secret', {
        SecretString: Match.objectLike({
          'Fn::Join': Match.arrayWith([Match.arrayWith([{ Ref: 'paramTestSecret' }])]),
        }),
      });

      // The App container gets an ECS secret named TEST_SECRET, sourced from
      // the ...:testSecret:: field of the app config secret.
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Secrets: Match.arrayWith([
              Match.objectLike({
                Name: 'TEST_SECRET',
                ValueFrom: Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp('.*:testSecret::')]),
                  ]),
                }),
              }),
            ]),
          }),
        ]),
      });
    });

    it('falls back to the load balancer URL when a fallbackToLoadBalancerUrl parameter is empty', () => {
      const { template } = synth(false, {
        secretParameters: [
          {
            parameterId: 'param_PublicUrl',
            secretKey: 'publicUrl',
            envName: 'NEXT_PUBLIC_WEBAPP_URL',
            fallbackToLoadBalancerUrl: true,
          },
        ],
      });

      // A condition on the parameter being provided...
      const conditions = template.toJSON().Conditions ?? {};
      expect(Object.keys(conditions)).toContain('paramPublicUrlProvided');

      // ...and the secret's publicUrl value resolves through Fn::If:
      // parameter when provided, http://<ALB DNS> otherwise.
      const secretString = JSON.stringify(
        Object.values(template.findResources('AWS::SecretsManager::Secret')).map(
          (resource) => resource['Properties']['SecretString'],
        ),
      );
      expect(secretString).toContain('paramPublicUrlProvided');
      expect(secretString).toContain('http://');
      expect(secretString).toContain('DNSName');
    });

    it('keeps the raw parameter for fallbackToLoadBalancerUrl specs in express mode', () => {
      const { template } = synth(true, {
        secretParameters: [
          {
            parameterId: 'param_PublicUrl',
            secretKey: 'publicUrl',
            envName: 'NEXT_PUBLIC_WEBAPP_URL',
            fallbackToLoadBalancerUrl: true,
          },
        ],
      });

      const conditions = template.toJSON().Conditions ?? {};
      expect(Object.keys(conditions)).not.toContain('paramPublicUrlProvided');
    });

    it('replaces the default curl health check with healthCheckShellCommand', () => {
      const { template } = synth(false, { healthCheckShellCommand: 'node -e "x"' });

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            HealthCheck: Match.objectLike({
              Command: ['CMD-SHELL', 'node -e "x"'],
            }),
          }),
        ]),
      });
    });

    it('applies taskCpu/taskMemoryMiB to the plain-Fargate task definition', () => {
      const { template } = synth(false, { taskCpu: 512, taskMemoryMiB: 1024 });

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Cpu: '512',
        Memory: '1024',
      });
    });

    it('applies startupGracePeriodSeconds to the container StartPeriod and service grace period', () => {
      const { template } = synth(false, { startupGracePeriodSeconds: 300 });

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            HealthCheck: Match.objectLike({ StartPeriod: 300 }),
          }),
        ]),
      });
      template.hasResourceProperties('AWS::ECS::Service', {
        HealthCheckGracePeriodSeconds: 300,
      });
    });

    it('leaves the service grace period at its CDK-derived default (60s, from the attached target group) when startupGracePeriodSeconds is not set', () => {
      // FargateService itself only ever gets an explicit `healthCheckGracePeriod`
      // when startupGracePeriodSeconds is set — the "absent" case is proven by
      // this matching the pre-existing committed snapshot (60s, CDK's own
      // default once a target group is attached) rather than our own 300s.
      const { template } = synth(false);
      template.hasResourceProperties('AWS::ECS::Service', {
        HealthCheckGracePeriodSeconds: 60,
      });
    });
  });

  describe('Secret-backed database URL', () => {
    it('creates no second secret when databaseUrlEnvNames is unset', () => {
      const { template } = synth();
      // Just the DB master-credential secret and the app config secret —
      // byte-identical to a stack without this feature.
      template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    });

    function findUrlSecret(template: Template): [string, TemplateResource] {
      const secrets = template.findResources('AWS::SecretsManager::Secret') as Record<
        string,
        TemplateResource
      >;
      const entry = Object.entries(secrets).find(([, resource]) =>
        JSON.stringify(resource.Properties?.['SecretString'] ?? '').includes(
          'postgresql://deployz_app:',
        ),
      );
      if (entry === undefined) {
        throw new Error('expected a DatabaseUrlSecret with a postgresql:// SecretString');
      }
      return entry;
    }

    it('assembles the complete PostgreSQL URL as a dynamic reference into the DB secret, never the password in plaintext', () => {
      const { template } = synth(false, {
        databaseUrlEnvNames: ['NEXT_PRIVATE_DATABASE_URL', 'NEXT_PRIVATE_DIRECT_DATABASE_URL'],
      });

      template.resourceCountIs('AWS::SecretsManager::Secret', 3);

      const [dbSecretId, urlSecret] = (() => {
        const secrets = template.findResources('AWS::SecretsManager::Secret') as Record<
          string,
          TemplateResource
        >;
        const entry = Object.entries(secrets).find(([, resource]) =>
          String(resource.Properties?.['Description'] ?? '').includes('RDS'),
        );
        if (entry === undefined) throw new Error('expected the DB master-credential secret');
        return entry;
      })();
      const [, urlSecretResource] = findUrlSecret(template);

      // The SecretString is an Fn::Join whose parts are the literal
      // "postgresql://deployz_app:" prefix, a {{resolve:secretsmanager:...}}
      // dynamic reference into the DB secret's `password` key (never the
      // password itself), the DB endpoint attribute, and the literal
      // ":5432/deployz?sslmode=require" suffix — the password is never
      // inlined as plaintext anywhere in the template.
      const secretStringProp = urlSecretResource.Properties?.['SecretString'] as {
        'Fn::Join': [string, unknown[]];
      };
      const parts = secretStringProp['Fn::Join'][1];

      expect(parts[0]).toBe('postgresql://deployz_app:{{resolve:secretsmanager:');
      expect(parts[1]).toEqual({ Ref: dbSecretId });
      expect(parts[2]).toBe(':SecretString:password::}}@');
      expect(parts).toContainEqual({ 'Fn::GetAtt': [expect.any(String), 'Endpoint.Address'] });
      expect(parts[parts.length - 1]).toBe(':5432/deployz?sslmode=require');

      // No unresolved CDK token anywhere (which would indicate the password
      // token was stringified instead of embedded as a CloudFormation
      // dynamic reference).
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toMatch(/\$\{Token\[/);
    });

    it('injects the URL secret into the App container under each configured env name, whole-value (no JSON key suffix)', () => {
      const { template } = synth(false, {
        databaseUrlEnvNames: ['NEXT_PRIVATE_DATABASE_URL', 'NEXT_PRIVATE_DIRECT_DATABASE_URL'],
      });
      const [urlSecretId] = findUrlSecret(template);

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Secrets: Match.arrayWith([
              Match.objectLike({
                Name: 'NEXT_PRIVATE_DATABASE_URL',
                ValueFrom: { Ref: urlSecretId },
              }),
              Match.objectLike({
                Name: 'NEXT_PRIVATE_DIRECT_DATABASE_URL',
                ValueFrom: { Ref: urlSecretId },
              }),
            ]),
          }),
        ]),
      });
    });

    it('grants the task execution role and task role read access to the URL secret', () => {
      const { template } = synth(false, {
        databaseUrlEnvNames: ['NEXT_PRIVATE_DATABASE_URL'],
      });
      const [urlSecretId] = findUrlSecret(template);

      const policies = template.findResources('AWS::IAM::Policy') as Record<
        string,
        TemplateResource
      >;
      const grantingPolicies = Object.values(policies).filter((policy) =>
        JSON.stringify(policy.Properties?.['PolicyDocument'] ?? '').includes(urlSecretId),
      );
      // The task execution role and task role each carry a policy statement
      // granting secretsmanager:GetSecretValue on the URL secret — same
      // grantRead pattern as the DB and app config secrets.
      expect(grantingPolicies.length).toBeGreaterThanOrEqual(2);
      for (const policy of grantingPolicies) {
        const statements = JSON.stringify(policy.Properties?.['PolicyDocument']);
        expect(statements).toContain('secretsmanager:GetSecretValue');
      }
    });
  });

  describe('Documenso preset', () => {
    it('produces exactly the built-in secret parameters plus every DOCUMENSO_PARAMETERS logical id, all NoEcho', () => {
      const { template } = synth(false, { ...DOCUMENSO_APPLICATION_PROPS });
      const params = appParameters(template);

      expect(Object.keys(params).sort()).toEqual(
        [
          'paramAppApiKey',
          'paramAppSigningSecret',
          'paramHealthCheckPath',
          ...Object.values(DOCUMENSO_PARAMETERS),
        ].sort(),
      );

      for (const [name, param] of Object.entries(params)) {
        expect(param['NoEcho'], `parameter ${name} must be NoEcho`).toBe(true);
      }
    });

    it('applies the Documenso health path to the container health check and target group (HTTP branch)', () => {
      const { template } = synth(false, { ...DOCUMENSO_APPLICATION_PROPS });

      // The path travels via the NoEcho parameter, defaulting to the preset
      // value — an install that sends its own canonical path overrides it.
      expect(appParameters(template)['paramHealthCheckPath']).toMatchObject({
        Default: '/api/health',
      });
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: { Ref: 'paramHealthCheckPath' },
        Port: 3000,
      });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            HealthCheck: Match.objectLike({
              Command: ['CMD-SHELL', DOCUMENSO_APPLICATION_PROPS.healthCheckShellCommand],
            }),
          }),
        ]),
      });
    });

    it('applies the Documenso health path to the target group in the HTTPS branch too', () => {
      const { template } = synth(false, {
        ...DOCUMENSO_APPLICATION_PROPS,
        certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/test',
      });

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        HealthCheckPath: { Ref: 'paramHealthCheckPath' },
        Port: 3000,
      });
    });

    it('injects NEXT_PUBLIC_BASE_PATH with an empty value into the App container', () => {
      const { template } = synth(false, { ...DOCUMENSO_APPLICATION_PROPS });

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Environment: Match.arrayWith([{ Name: 'NEXT_PUBLIC_BASE_PATH', Value: '' }]),
          }),
        ]),
      });
    });
  });
});

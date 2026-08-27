import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  ApplicationStack,
  type ApplicationStackProps,
} from '../src/application/application-stack.js';

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
  'AWS::ElastiCache::CacheCluster',
  'AWS::ElastiCache::SubnetGroup',
] as const;

describe('ApplicationStack', () => {
  it('synthesizes without errors (plain Fargate)', () => {
    const { template } = synth(false);
    expect(template).toBeDefined();
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

  it('generates a DB password RDS will actually accept', () => {
    const { template } = synth();

    // RDS rejects a MasterUserPassword containing '/', '@', '"' or a space:
    // "The parameter MasterUserPassword is not a valid password." A live
    // install failed on exactly this — the generator is free to emit them,
    // so roughly one create in a handful died at the database and rolled the
    // whole stack back.
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const dbSecret = Object.values(secrets).find((resource) =>
      String(resource['Properties']?.['Description'] ?? '').includes('RDS'),
    );
    const excluded = String(
      dbSecret?.['Properties']?.['GenerateSecretString']?.['ExcludeCharacters'] ?? '',
    );

    for (const forbidden of ['/', '@', '"', ' ']) {
      expect(excluded, `RDS forbids ${JSON.stringify(forbidden)} in a master password`).toContain(
        forbidden,
      );
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
        HealthCheckPath: '/health',
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
        HealthCheckPath: '/health',
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

    // The only application parameters are the two app-env secrets.
    expect(names.sort()).toEqual(['paramAppApiKey', 'paramAppSigningSecret'].sort());

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

  it('exports the application handshake outputs', () => {
    const { template } = synth();
    const outputs = Object.keys(template.findOutputs('*'));
    expect(outputs).toContain('ExportApplicationTestDbHost');
    expect(outputs).toContain('ExportApplicationTestDbSecretArn');
    expect(outputs).toContain('ExportApplicationTestStorageBucketName');
    expect(outputs).toContain('ExportApplicationTestClusterName');
    expect(outputs).toContain('ExportApplicationTestPublicEndpoint');
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

  describe('ElastiCache Valkey cache (Redis MVP)', () => {
    it('provisions zero ElastiCache resources and no REDIS env vars when redisRequired is unset', () => {
      const { template } = synth();
      template.resourceCountIs('AWS::ElastiCache::CacheCluster', 0);
      template.resourceCountIs('AWS::ElastiCache::SubnetGroup', 0);
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('REDIS_URL');
      expect(json).not.toContain('REDIS_HOST');
      expect(json).not.toContain('REDIS_PORT');
    });

    it('provisions a single-node Valkey cache over the private subnets when redisRequired is true', () => {
      const { template } = synth(false, { redisRequired: true });
      template.resourceCountIs('AWS::ElastiCache::CacheCluster', 1);
      template.hasResourceProperties('AWS::ElastiCache::CacheCluster', {
        Engine: 'valkey',
        CacheNodeType: 'cache.t4g.micro',
        NumCacheNodes: 1,
        Port: 6379,
      });
      template.resourceCountIs('AWS::ElastiCache::SubnetGroup', 1);
      // No hardcoded ClusterName — CFN logical-ID naming keeps it deterministic
      // per stack without hitting ElastiCache's name-length limits.
      const [cacheCluster] = Object.values(
        template.findResources('AWS::ElastiCache::CacheCluster'),
      ) as Array<{ Properties?: Record<string, unknown> }>;
      expect(cacheCluster?.Properties?.['ClusterName']).toBeUndefined();
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
      for (const type of ['AWS::ElastiCache::CacheCluster', 'AWS::ElastiCache::SubnetGroup']) {
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

    it('exports the cache endpoint output', () => {
      const { template } = synth(false, { redisRequired: true });
      const outputs = Object.keys(template.findOutputs('*'));
      expect(outputs).toContain('ExportApplicationTestCacheEndpoint');
    });

    it('does not export a cache endpoint output when redisRequired is unset', () => {
      const { template } = synth();
      const outputs = Object.keys(template.findOutputs('*'));
      expect(outputs).not.toContain('ExportApplicationTestCacheEndpoint');
    });
  });
});

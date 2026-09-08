import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  ApplicationStack,
  type ApplicationStackProps,
} from '../src/application/application-stack.js';

function synth(extraProps: Partial<ApplicationStackProps> = {}) {
  const app = new App();
  const stack = new ApplicationStack(app, 'CapabilityMatrixTest', {
    allowInsecureHttp: true,
    ...extraProps,
  });
  return { template: Template.fromStack(stack), stack };
}

type TemplateResource = { Type: string; Properties?: Record<string, unknown> };

function allResources(template: Template): Record<string, TemplateResource> {
  return (template.toJSON() as { Resources: Record<string, TemplateResource> })['Resources'];
}

function appParameters(
  template: Template,
): Record<string, Record<string, unknown>> {
  const params = (
    template.toJSON() as { Parameters?: Record<string, Record<string, unknown>> }
  )['Parameters'];
  return Object.fromEntries(
    Object.entries(params ?? {}).filter(([name]) => name !== 'BootstrapVersion'),
  );
}

function deletionPolicy(resource: TemplateResource): unknown {
  return (resource as unknown as Record<string, unknown>)['DeletionPolicy'];
}

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

// ── 1. Capability matrix: four combinations of databaseRequired × redisRequired ──

describe('Capability matrix', () => {
  describe('DB=false, Redis=false', () => {
    it('provisions zero RDS and zero ElastiCache resources', () => {
      const { template } = synth({
        databaseRequired: false,
        redisRequired: false,
      });
      template.resourceCountIs('AWS::RDS::DBInstance', 0);
      template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 0);
      template.resourceCountIs('AWS::ElastiCache::SubnetGroup', 0);
    });

    it('injects no DATABASE_* or REDIS_* container env', () => {
      const { template } = synth({
        databaseRequired: false,
        redisRequired: false,
      });
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('DATABASE_HOST');
      expect(json).not.toContain('DATABASE_PORT');
      expect(json).not.toContain('DATABASE_NAME');
      expect(json).not.toContain('DATABASE_USER');
      expect(json).not.toContain('DATABASE_PASSWORD');
      expect(json).not.toContain('DATABASE_URL');
      expect(json).not.toContain('REDIS_URL');
      expect(json).not.toContain('REDIS_HOST');
      expect(json).not.toContain('REDIS_PORT');
    });

    it('omits the DB stack outputs', () => {
      const { template } = synth({
        databaseRequired: false,
        redisRequired: false,
      });
      const outputs = Object.keys(template.findOutputs('*'));
      expect(outputs).not.toContain('DbHost');
      expect(outputs).not.toContain('DbSecretArn');
      expect(outputs).not.toContain('CacheEndpoint');
      // Non-DB, non-cache outputs are unaffected.
      expect(outputs).toContain('StorageBucketName');
      expect(outputs).toContain('PublicEndpoint');
    });
  });

  describe('DB=true, Redis=false', () => {
    it('provisions exactly 1 DBInstance and 0 ElastiCache', () => {
      const { template } = synth({
        databaseRequired: true,
        redisRequired: false,
      });
      template.resourceCountIs('AWS::RDS::DBInstance', 1);
      template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 0);
    });

    it('injects DATABASE_* env vars and DATABASE_URL ECS secret', () => {
      const { template } = synth({
        databaseRequired: true,
        redisRequired: false,
      });
      // DATABASE_HOST/PORT/NAME/USER are plain env vars.
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'DATABASE_HOST' }),
              Match.objectLike({ Name: 'DATABASE_PORT' }),
              Match.objectLike({ Name: 'DATABASE_NAME' }),
              Match.objectLike({ Name: 'DATABASE_USER' }),
            ]),
          }),
        ]),
      });
      // DATABASE_PASSWORD is an ECS secret.
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'DATABASE_PASSWORD' }),
            ]),
          }),
        ]),
      });
      // DATABASE_URL is an ECS secret from the assembled connection URL.
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'DATABASE_URL' }),
            ]),
          }),
        ]),
      });
      // No REDIS_* env vars when redisRequired is false.
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('REDIS_URL');
    });
  });

  describe('DB=false, Redis=true', () => {
    it('provisions 0 DBInstance and 1 ElastiCache ReplicationGroup', () => {
      const { template } = synth({
        databaseRequired: false,
        redisRequired: true,
      });
      template.resourceCountIs('AWS::RDS::DBInstance', 0);
      template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
      template.resourceCountIs('AWS::ElastiCache::SubnetGroup', 1);
    });

    it('injects REDIS_* env vars and no DATABASE_* env vars', () => {
      const { template } = synth({
        databaseRequired: false,
        redisRequired: true,
      });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'REDIS_URL' }),
              Match.objectLike({ Name: 'REDIS_HOST' }),
              Match.objectLike({ Name: 'REDIS_PORT' }),
            ]),
          }),
        ]),
      });
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('DATABASE_HOST');
      expect(json).not.toContain('DATABASE_URL');
    });
  });

  describe('DB=true, Redis=true', () => {
    it('provisions both RDS and ElastiCache', () => {
      const { template } = synth({
        databaseRequired: true,
        redisRequired: true,
      });
      template.resourceCountIs('AWS::RDS::DBInstance', 1);
      template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
    });

    it('injects both DATABASE_* and REDIS_* env vars', () => {
      const { template } = synth({
        databaseRequired: true,
        redisRequired: true,
      });
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'App',
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'DATABASE_HOST' }),
              Match.objectLike({ Name: 'DATABASE_PORT' }),
              Match.objectLike({ Name: 'DATABASE_NAME' }),
              Match.objectLike({ Name: 'DATABASE_USER' }),
              Match.objectLike({ Name: 'REDIS_URL' }),
              Match.objectLike({ Name: 'REDIS_HOST' }),
              Match.objectLike({ Name: 'REDIS_PORT' }),
            ]),
          }),
        ]),
      });
    });
  });
});

// ── 2. Ingress: default (no certificateArn) vs HTTPS with certificateArn ──

describe('Ingress', () => {
  it('creates an HTTP:80 listener when allowInsecureHttp is true and no certificateArn', () => {
    const { template } = synth({ allowInsecureHttp: true });
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });

  it('creates an HTTPS:443 listener when certificateArn is supplied', () => {
    const { template } = synth({
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
  });
});

// ── 3. Health check: default vs override ──

describe('Health check', () => {
  it('defaults to /health in the param default and target group', () => {
    const { template } = synth();
    expect(appParameters(template)['paramHealthCheckPath']).toMatchObject({
      NoEcho: true,
      Default: '/health',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: { Ref: 'paramHealthCheckPath' },
    });
  });

  it('uses the overridden health check path in the param default', () => {
    const { template } = synth({ healthCheckPath: '/healthz' });
    expect(appParameters(template)['paramHealthCheckPath']).toMatchObject({
      NoEcho: true,
      Default: '/healthz',
    });
  });
});

// ── 4. Port override ──

describe('Port override', () => {
  it('applies containerPort 8080 to the param default and target group port', () => {
    const { template } = synth({ containerPort: 8080 });
    expect(appParameters(template)['paramContainerPort']).toMatchObject({
      NoEcho: true,
      Default: '8080',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: { Ref: 'paramContainerPort' },
    });
  });
});

// ── 5. Compute override ──

describe('Compute override', () => {
  it('applies taskCpu 1024 and taskMemoryMiB 2048 to the task definition', () => {
    const { template } = synth({ taskCpu: 1024, taskMemoryMiB: 2048 });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '1024',
      Memory: '2048',
    });
  });
});

// ── 6. Retention and storage gate ──

describe('Retention', () => {
  it('retains the RDS instance (DeletionPolicy: Retain)', () => {
    const { template } = synth();
    const resources = allResources(template);
    const [, database] = Object.entries(resources).find(
      ([, r]) => r.Type === 'AWS::RDS::DBInstance',
    )!;
    expect(deletionPolicy(database)).toBe('Retain');
  });

  it('retains the S3 bucket (DeletionPolicy: Retain)', () => {
    const { template } = synth();
    const resources = allResources(template);
    const [, bucket] = Object.entries(resources).find(
      ([, r]) => r.Type === 'AWS::S3::Bucket',
    )!;
    expect(deletionPolicy(bucket)).toBe('Retain');
  });

  it('omits S3 binding env vars when storageRequired is false', () => {
    const { template } = synth({ storageRequired: false });
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('S3_BUCKET');
    expect(json).not.toContain('AWS_S3_BUCKET');
    // The bucket itself is still provisioned — only the env injection gates.
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });
});

// ── 7. Tags: deployz:application / deployz:vendor / deployz:installation ──

describe('Tags', () => {
  it('applies deployz:application to taggable resources when applicationId is supplied', () => {
    const { template } = synth({ applicationId: 'app-matrix-1' });
    for (const type of TAGGABLE_TYPES) {
      const resources = template.findResources(type) as Record<
        string,
        { Properties?: Record<string, unknown> }
      >;
      for (const [logicalId, resource] of Object.entries(resources)) {
        const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
        const tag = tags.find((t) => t['Key'] === 'deployz:application');
        expect(tag?.['Value'], `${type} ${logicalId}`).toBe('app-matrix-1');
      }
    }
  });

  it('applies deployz:vendor to taggable resources when vendorId is supplied', () => {
    const { template } = synth({ vendorId: 'vendor-matrix-1' });
    for (const type of TAGGABLE_TYPES) {
      const resources = template.findResources(type) as Record<
        string,
        { Properties?: Record<string, unknown> }
      >;
      for (const [logicalId, resource] of Object.entries(resources)) {
        const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
        const tag = tags.find((t) => t['Key'] === 'deployz:vendor');
        expect(tag?.['Value'], `${type} ${logicalId}`).toBe('vendor-matrix-1');
      }
    }
  });

  it('applies deployz:installation to taggable resources when installationId is supplied', () => {
    const { template } = synth({ installationId: 'inst-matrix-1' });
    for (const type of TAGGABLE_TYPES) {
      const resources = template.findResources(type) as Record<
        string,
        { Properties?: Record<string, unknown> }
      >;
      for (const [logicalId, resource] of Object.entries(resources)) {
        const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
        const tag = tags.find((t) => t['Key'] === 'deployz:installation');
        expect(tag?.['Value'], `${type} ${logicalId}`).toBe('inst-matrix-1');
      }
    }
  });
});

// ── 8. Outputs ──

describe('Outputs', () => {
  it('publishes the PublicEndpoint output for the ALB DNS name', () => {
    const { template } = synth();
    const outputs = Object.keys(template.findOutputs('*'));
    expect(outputs).toContain('PublicEndpoint');
  });
});
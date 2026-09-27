import type {
  DeployzIR,
  InfrastructureComponentKind,
  InfrastructureSizeProfile,
  Region,
  IrResource,
  IrWorkload,
} from '@deployz/contracts';
import { CAPABILITY_KEYS, defaultInfrastructureSizeProfile } from '@deployz/contracts';

import { logicalResourceId, logicalIdViolations } from './stable-identity.js';
import type {
  DeletionPolicy,
  PurgeStrategy,
  ResolvedAwsGraph,
  ResolvedCondition,
  ResolvedOutput,
  ResolvedParameter,
  ResolvedResource,
  Retention,
} from './resolved-graph.js';

// ---------------------------------------------------------------------------
// dynamic-compiler-v2 — the deterministic infrastructure compiler.
//
// Input: DeployzIR + size profile + region + compiler version.
// Output: a resolved AWS graph (resources with stable identity + lifecycle),
// a deterministic CloudFormation template, and the derived footprint /
// verification contract / ownership records.
//
// The compiler is a pure function: no AI, no synth-time AWS discovery, no
// timestamps, no random ids, no unstable iteration. Equivalent IR + profile +
// region + compiler version always produce an equivalent graph.
//
// It composes the current capabilities from DeployzIR (VPC + ECS Fargate +
// ALB + S3 + Secrets Manager + optional RDS PostgreSQL + optional ElastiCache
// Valkey) into a resolved AWS graph with stable semantic logical ids. CDK
// stays the control-plane mechanism; this compiler emits CloudFormation
// directly and is the architectural boundary the relay consumes.
// ---------------------------------------------------------------------------

// ── CFN intrinsic helpers ────────────────────────────────────────────────────
const ref = (id: string): Record<string, unknown> => ({ Ref: id });
const getAtt = (id: string, attr: string): Record<string, unknown> => ({ 'Fn::GetAtt': [id, attr] });
const join = (sep: string, parts: readonly unknown[]): Record<string, unknown> => ({ 'Fn::Join': [sep, parts] });
const select = (i: number, value: unknown): Record<string, unknown> => ({ 'Fn::Select': [i, value] });
const azOf = (i: number): Record<string, unknown> => select(i, { 'Fn::GetAZs': '' });

// ── Tag model (matches runtime-v1 static tags; identity tags are applied by
//    the relay at CreateStack time, never baked into the artifact) ───────────
const TAG_ENVIRONMENT = 'production';
const TAG_MANAGED = 'true';
const TAG_MANAGED_BY = 'deployz';
const TAG_SCOPE = 'customer';

/** The `deployz:component` value runtime-v1 assigns per graph component id. */
function componentTag(componentId: string): string {
  switch (componentId) {
    case 'network':
      return 'network';
    case 'primary-db':
      return 'database';
    case 'cache':
      return 'redis';
    case 'storage':
      return 'storage';
    case 'endpoint':
      return 'network';
    default:
      return 'app';
  }
}

function tags(componentId: string): Array<{ Key: string; Value: string }> {
  return [
    { Key: 'deployz:component', Value: componentTag(componentId) },
    { Key: 'deployz:environment', Value: TAG_ENVIRONMENT },
    { Key: 'deployz:managed', Value: TAG_MANAGED },
    { Key: 'deployz:managed-by', Value: TAG_MANAGED_BY },
    { Key: 'deployz:scope', Value: TAG_SCOPE },
  ];
}

// ── Fixed sizing / engine constants (pinned to the small-v1 profile + the
//    runtime-v1 template constants; see sizing parity) ───────────────────────
const DB_ENGINE = 'postgres';
const DB_ENGINE_VERSION = '16';
const DB_NAME = 'deployz';
const DB_USER = 'deployz_app';
const DB_PORT = 5432;
const REDIS_ENGINE = 'valkey';
const REDIS_PORT = 6379;
const RDS_CA_VOLUME = 'deployz-rds-ca';
const RDS_CA_DIR = '/deployz/certs';
const RDS_CA_BUNDLE_PATH = `${RDS_CA_DIR}/rds-ca-bundle.pem`;
const RDS_CA_INIT_IMAGE = 'public.ecr.aws/amazonlinux/amazonlinux:2023-minimal';
const DEFAULT_IMAGE_REPOSITORY = 'public.ecr.aws/deployz/fixture';
const DEFAULT_IMAGE_DIGEST =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const APP_PORT = 3000;
const HEALTH_CHECK_PATH = '/health';

// VPC CIDR layout — deterministic, matches runtime-v1's 2-AZ /16 split.
const VPC_CIDR = '10.0.0.0/16';
const PUBLIC_SUBNET_CIDRS = ['10.0.0.0/18', '10.0.64.0/18'] as const;
const PRIVATE_SUBNET_CIDRS = ['10.0.128.0/18', '10.0.192.0/18'] as const;

// ── Compiler version / capability registry identity ─────────────────────────
export const COMPILER_VERSION = 'dynamic-compiler-v2-1' as const;

interface ResInput {
  readonly componentId: string;
  readonly componentKind: InfrastructureComponentKind;
  readonly capability: string;
  readonly resourceRole: string;
  readonly cfnType: string;
  readonly stateful?: boolean;
  readonly deletionPolicy?: DeletionPolicy;
  readonly retention?: Retention;
  readonly purgeStrategy?: PurgeStrategy;
  readonly verificationCheck?: string;
  readonly properties: Record<string, unknown>;
  readonly dependsOn?: readonly string[];
}

function res(input: ResInput): ResolvedResource {
  const stateful = input.stateful ?? false;
  const deletionPolicy = input.deletionPolicy ?? (stateful ? 'Retain' : 'Delete');
  return {
    logicalId: logicalResourceId(input.componentId, input.resourceRole),
    componentId: input.componentId,
    componentKind: input.componentKind,
    capability: input.capability,
    resourceRole: input.resourceRole,
    cfnType: input.cfnType,
    stateful,
    deletionPolicy,
    updateReplacePolicy: deletionPolicy,
    retention: input.retention ?? (stateful ? 'retain' : 'delete'),
    purgeStrategy: input.purgeStrategy ?? (stateful ? 'require_manual' : null),
    ...(input.verificationCheck !== undefined ? { verificationCheck: input.verificationCheck } : {}),
    properties: input.properties,
    ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
  };
}

// ── Shared logical ids (single source of truth for cross-references) ────────
interface NetIds {
  readonly vpc: string;
  readonly publicSubnets: readonly [string, string];
  readonly privateSubnets: readonly [string, string];
  readonly igw: string;
  readonly vpcGwAttachment: string;
  readonly natEip: string;
  readonly natGateway: string;
}

function netIds(): NetIds {
  return {
    vpc: logicalResourceId('network', 'vpc'),
    publicSubnets: [logicalResourceId('network', 'public-subnet-1'), logicalResourceId('network', 'public-subnet-2')],
    privateSubnets: [logicalResourceId('network', 'private-subnet-1'), logicalResourceId('network', 'private-subnet-2')],
    igw: logicalResourceId('network', 'internet-gateway'),
    vpcGwAttachment: logicalResourceId('network', 'vpc-gateway-attachment'),
    natEip: logicalResourceId('network', 'nat-eip'),
    natGateway: logicalResourceId('network', 'nat-gateway'),
  };
}

// ── Capability compilers ─────────────────────────────────────────────────────

/** VPC + subnets + routes + NAT — shared by every topology. */
function compileNetwork(ids: NetIds): ResolvedResource[] {
  const out: ResolvedResource[] = [];
  const net = { componentId: 'network', componentKind: 'network' as const, capability: 'aws.network' };

  out.push(res({
    ...net,
    resourceRole: 'vpc',
    cfnType: 'AWS::EC2::VPC',
    properties: {
      CidrBlock: VPC_CIDR,
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
      InstanceTenancy: 'default',
      Tags: tags('network'),
    },
  }));

  const routeTables: string[] = [];
  for (let i = 0; i < 2; i++) {
    const pubSubnet = logicalResourceId('network', `public-subnet-${i + 1}`);
    const privSubnet = logicalResourceId('network', `private-subnet-${i + 1}`);
    const pubRt = logicalResourceId('network', `public-route-table-${i + 1}`);
    const privRt = logicalResourceId('network', `private-route-table-${i + 1}`);

    out.push(res({
      ...net, resourceRole: `public-subnet-${i + 1}`, cfnType: 'AWS::EC2::Subnet',
      properties: { AvailabilityZone: azOf(i), CidrBlock: PUBLIC_SUBNET_CIDRS[i], MapPublicIpOnLaunch: true, Tags: tags('network'), VpcId: ref(ids.vpc) },
    }));
    out.push(res({
      ...net, resourceRole: `private-subnet-${i + 1}`, cfnType: 'AWS::EC2::Subnet',
      properties: { AvailabilityZone: azOf(i), CidrBlock: PRIVATE_SUBNET_CIDRS[i], MapPublicIpOnLaunch: false, Tags: tags('network'), VpcId: ref(ids.vpc) },
    }));
    out.push(res({ ...net, resourceRole: `public-route-table-${i + 1}`, cfnType: 'AWS::EC2::RouteTable', properties: { Tags: tags('network'), VpcId: ref(ids.vpc) } }));
    out.push(res({ ...net, resourceRole: `private-route-table-${i + 1}`, cfnType: 'AWS::EC2::RouteTable', properties: { Tags: tags('network'), VpcId: ref(ids.vpc) } }));
    out.push(res({
      ...net, resourceRole: `public-route-table-association-${i + 1}`, cfnType: 'AWS::EC2::SubnetRouteTableAssociation',
      properties: { RouteTableId: ref(pubRt), SubnetId: ref(pubSubnet) },
    }));
    out.push(res({
      ...net, resourceRole: `private-route-table-association-${i + 1}`, cfnType: 'AWS::EC2::SubnetRouteTableAssociation',
      properties: { RouteTableId: ref(privRt), SubnetId: ref(privSubnet) },
    }));
    out.push(res({
      ...net, resourceRole: `public-route-${i + 1}`, cfnType: 'AWS::EC2::Route',
      properties: { DestinationCidrBlock: '0.0.0.0/0', GatewayId: ref(ids.igw), RouteTableId: ref(pubRt) },
      dependsOn: [ids.vpcGwAttachment],
    }));
    out.push(res({
      ...net, resourceRole: `private-route-${i + 1}`, cfnType: 'AWS::EC2::Route',
      properties: { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: ref(ids.natGateway), RouteTableId: ref(privRt) },
    }));
    routeTables.push(pubRt, privRt);
  }

  out.push(res({ ...net, resourceRole: 'internet-gateway', cfnType: 'AWS::EC2::InternetGateway', properties: { Tags: tags('network') } }));
  out.push(res({
    ...net, resourceRole: 'vpc-gateway-attachment', cfnType: 'AWS::EC2::VPCGatewayAttachment',
    properties: { InternetGatewayId: ref(ids.igw), VpcId: ref(ids.vpc) },
  }));
  out.push(res({ ...net, resourceRole: 'nat-eip', cfnType: 'AWS::EC2::EIP', properties: { Domain: 'vpc', Tags: tags('network') } }));
  out.push(res({
    ...net, resourceRole: 'nat-gateway', cfnType: 'AWS::EC2::NatGateway',
    properties: { AllocationId: getAtt(ids.natEip, 'AllocationId'), SubnetId: ref(ids.publicSubnets[0]), Tags: tags('network') },
    dependsOn: [logicalResourceId('network', 'public-route-1'), logicalResourceId('network', 'public-route-table-association-1')],
  }));

  return out;
}

/** App config secret (Secrets Manager) — always present, Delete lifecycle. */
function compileAppSecret(): ResolvedResource {
  return res({
    componentId: 'application',
    componentKind: 'other',
    capability: CAPABILITY_KEYS.SECRETS_MANAGER,
    resourceRole: 'config-secret',
    cfnType: 'AWS::SecretsManager::Secret',
    stateful: false,
    properties: {
      Description: 'Application runtime secrets (vendor/customer config) supplied via NoEcho parameters at deploy time. Never returned to the control plane.',
      SecretString: join('', ['{"apiKey":"', ref('paramAppApiKey'), '","signingSecret":"', ref('paramAppSigningSecret'), '"}']),
      Tags: tags('application'),
    },
  });
}

/** S3 object storage — always present, Retain lifecycle. */
function compileS3(): ResolvedResource[] {
  const bucket = logicalResourceId('storage', 'bucket');
  return [
    res({
      componentId: 'storage',
      componentKind: 'storage',
      capability: CAPABILITY_KEYS.S3,
      resourceRole: 'bucket',
      cfnType: 'AWS::S3::Bucket',
      stateful: true,
      retention: 'retain',
      purgeStrategy: 'require_manual',
      verificationCheck: 'storage',
      properties: {
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        LifecycleConfiguration: {
          Rules: [
            { Id: 'ExpireNoncurrentVersions', NoncurrentVersionExpiration: { NoncurrentDays: 30 }, Status: 'Enabled' },
            { AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, Id: 'AbortIncompleteMultipartUploads', Status: 'Enabled' },
          ],
        },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        Tags: tags('storage'),
        VersioningConfiguration: { Status: 'Enabled' },
      },
    }),
    res({
      componentId: 'storage',
      componentKind: 'storage',
      capability: CAPABILITY_KEYS.S3,
      resourceRole: 'bucket-policy',
      cfnType: 'AWS::S3::BucketPolicy',
      properties: {
        Bucket: ref(bucket),
        PolicyDocument: {
          Statement: [{
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Resource: [getAtt(bucket, 'Arn'), join('', [getAtt(bucket, 'Arn'), '/*'])],
          }],
          Version: '2012-10-17',
        },
      },
    }),
  ];
}

/** Log group for ECS tasks — one week retention, Delete lifecycle. */
function compileLogGroup(): ResolvedResource {
  return res({
    componentId: 'web',
    componentKind: 'monitoring',
    capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
    resourceRole: 'log-group',
    cfnType: 'AWS::Logs::LogGroup',
    properties: { RetentionInDays: 7, Tags: tags('web') },
  });
}

/** RDS PostgreSQL — Retain lifecycle (stateful). */
function compileRdsPostgres(dbResource: IrResource, profile: InfrastructureSizeProfile, ids: NetIds, serviceSgId: string): ResolvedResource[] {
  const out: ResolvedResource[] = [];
  const componentId = dbResource.componentId;
  const secret = logicalResourceId(componentId, 'master-secret');
  const sg = logicalResourceId(componentId, 'security-group');
  const subnetGroup = logicalResourceId(componentId, 'subnet-group');
  const instance = logicalResourceId(componentId, 'instance');

  out.push(res({
    componentId, componentKind: 'database', capability: CAPABILITY_KEYS.RDS_POSTGRES, resourceRole: 'master-secret',
    cfnType: 'AWS::SecretsManager::Secret', stateful: true, retention: 'retain', purgeStrategy: 'require_manual',
    properties: {
      Description: 'RDS PostgreSQL master credentials for the customer application. Generated by CloudFormation at deploy time — never a template parameter.',
      GenerateSecretString: { ExcludePunctuation: true, GenerateStringKey: 'password', PasswordLength: 32, SecretStringTemplate: `{"username":"${DB_USER}"}` },
      Tags: tags(componentId),
    },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: CAPABILITY_KEYS.RDS_POSTGRES, resourceRole: 'security-group',
    cfnType: 'AWS::EC2::SecurityGroup',
    properties: { GroupDescription: 'RDS PostgreSQL access for the customer application', SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default', IpProtocol: '-1' }], Tags: tags(componentId), VpcId: ref(ids.vpc) },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: CAPABILITY_KEYS.RDS_POSTGRES, resourceRole: 'subnet-group',
    cfnType: 'AWS::RDS::DBSubnetGroup', stateful: true, retention: 'retain',
    properties: { DBSubnetGroupDescription: `Subnet group for ${componentId} database`, SubnetIds: [ref(ids.privateSubnets[0]), ref(ids.privateSubnets[1])], Tags: tags(componentId) },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: CAPABILITY_KEYS.RDS_POSTGRES, resourceRole: 'instance',
    cfnType: 'AWS::RDS::DBInstance', stateful: true, retention: 'retain', purgeStrategy: 'require_manual', verificationCheck: 'database',
    properties: {
      AllocatedStorage: String(profile.database.storageGb),
      BackupRetentionPeriod: 7,
      CopyTagsToSnapshot: true,
      DBInstanceClass: profile.database.instanceClass,
      DBName: DB_NAME,
      DBSubnetGroupName: ref(subnetGroup),
      DeleteAutomatedBackups: false,
      DeletionProtection: true,
      Engine: DB_ENGINE,
      EngineVersion: DB_ENGINE_VERSION,
      MasterUserPassword: join('', [`{{resolve:secretsmanager:`, ref(secret), `:SecretString:password::}}`]),
      MasterUsername: DB_USER,
      MaxAllocatedStorage: profile.database.maxStorageGb,
      PreferredBackupWindow: '03:00-05:00',
      PubliclyAccessible: false,
      StorageEncrypted: true,
      StorageType: 'gp2',
      Tags: tags(componentId),
      VPCSecurityGroups: [getAtt(sg, 'GroupId')],
    },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: CAPABILITY_KEYS.RDS_POSTGRES, resourceRole: 'secret-attachment',
    cfnType: 'AWS::SecretsManager::SecretTargetAttachment',
    properties: { SecretId: ref(secret), TargetId: ref(instance), TargetType: 'AWS::RDS::DBInstance' },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: CAPABILITY_KEYS.RDS_POSTGRES, resourceRole: 'url-secret',
    cfnType: 'AWS::SecretsManager::Secret', stateful: true, retention: 'retain', purgeStrategy: 'require_manual',
    properties: {
      Description: 'Complete PostgreSQL connection URL for the customer application. Assembled at deploy time from the generated master credentials — the password never appears in the template or task definition.',
      SecretString: join('', [`postgresql://${DB_USER}:{{resolve:secretsmanager:`, ref(secret), `:SecretString:password::}}@`, getAtt(instance, 'Endpoint.Address'), `:${DB_PORT}/${DB_NAME}?sslmode=require`]),
      Tags: tags(componentId),
    },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: CAPABILITY_KEYS.RDS_POSTGRES, resourceRole: 'app-service-ingress',
    cfnType: 'AWS::EC2::SecurityGroupIngress',
    properties: { Description: 'Allow the application to reach RDS PostgreSQL', FromPort: DB_PORT, GroupId: getAtt(sg, 'GroupId'), IpProtocol: 'tcp', SourceSecurityGroupId: getAtt(serviceSgId, 'GroupId'), ToPort: DB_PORT },
  }));

  return out;
}

/** ElastiCache Valkey — stateless (Delete on stack delete). */
function compileElasticache(cacheResource: IrResource, profile: InfrastructureSizeProfile, ids: NetIds): ResolvedResource[] {
  const componentId = cacheResource.componentId;
  const sg = logicalResourceId(componentId, 'security-group');
  const subnetGroup = logicalResourceId(componentId, 'subnet-group');

  return [
    res({
      componentId, componentKind: 'cache', capability: CAPABILITY_KEYS.ELASTICACHE_VALKEY, resourceRole: 'subnet-group',
      cfnType: 'AWS::ElastiCache::SubnetGroup',
      properties: { Description: 'Deployz-managed private subnet group for the ElastiCache Valkey cache', SubnetIds: [ref(ids.privateSubnets[0]), ref(ids.privateSubnets[1])], Tags: tags(componentId) },
    }),
    res({
      componentId, componentKind: 'cache', capability: CAPABILITY_KEYS.ELASTICACHE_VALKEY, resourceRole: 'security-group',
      cfnType: 'AWS::EC2::SecurityGroup',
      properties: {
        GroupDescription: 'ElastiCache Valkey access for the customer application',
        SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default', IpProtocol: '-1' }],
        SecurityGroupIngress: [{ CidrIp: VPC_CIDR, Description: 'Allow the application to reach the ElastiCache Valkey cache', FromPort: REDIS_PORT, IpProtocol: 'tcp', ToPort: REDIS_PORT }],
        Tags: tags(componentId),
        VpcId: ref(ids.vpc),
      },
    }),
    res({
      componentId, componentKind: 'cache', capability: CAPABILITY_KEYS.ELASTICACHE_VALKEY, resourceRole: 'replication-group',
      cfnType: 'AWS::ElastiCache::ReplicationGroup', verificationCheck: 'cache',
      properties: {
        AutomaticFailoverEnabled: false,
        CacheNodeType: profile.cache.nodeType,
        CacheSubnetGroupName: ref(subnetGroup),
        Engine: REDIS_ENGINE,
        MultiAZEnabled: false,
        NumCacheClusters: profile.cache.nodeCount,
        Port: REDIS_PORT,
        ReplicationGroupDescription: 'Deployz-managed single-node Valkey cache for the customer application',
        SecurityGroupIds: [getAtt(sg, 'GroupId')],
        Tags: tags(componentId),
        TransitEncryptionEnabled: false,
      },
      dependsOn: [subnetGroup],
    }),
  ];
}

// ── ECS + ALB (the workload/ingress half) ────────────────────────────────────

interface EcsContext {
  readonly ids: NetIds;
  readonly hasDb: boolean;
  readonly hasRedis: boolean;
  readonly db: { componentId: string; secret: string; urlSecret: string; instance: string } | undefined;
  readonly cache: { componentId: string; replicationGroup: string } | undefined;
}

/** IAM roles + policies + cluster — shared by the web workload. */
function compileEcsShared(ctx: EcsContext, workload: IrWorkload): ResolvedResource[] {
  const componentId = workload.componentId;
  const logGroup = logicalResourceId(componentId, 'log-group');
  const execRole = logicalResourceId(componentId, 'task-execution-role');
  const execPolicy = logicalResourceId(componentId, 'task-execution-role-policy');
  const taskRole = logicalResourceId(componentId, 'task-role');
  const taskPolicy = logicalResourceId(componentId, 'task-role-policy');

  const secretReadStatements = (secrets: readonly string[]): unknown[] =>
    secrets.map((s) => ({
      Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      Effect: 'Allow',
      Resource: ref(s),
    }));

  const dbSecrets = ctx.db !== undefined ? [ctx.db.secret, ctx.db.urlSecret] : [];
  const secretArns = [...dbSecrets, logicalResourceId('application', 'config-secret')];

  return [
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'cluster',
      cfnType: 'AWS::ECS::Cluster', properties: { Tags: tags(componentId) },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-execution-role',
      cfnType: 'AWS::IAM::Role',
      properties: {
        AssumeRolePolicyDocument: { Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' } }], Version: '2012-10-17' },
        Description: 'Allows ECS to pull the application image, write task logs, and inject secrets from Secrets Manager at task start.',
        ManagedPolicyArns: [join('', ['arn:', ref('AWS::Partition'), ':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'])],
        Path: '/deployz/',
        Tags: tags(componentId),
      },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-execution-role-policy',
      cfnType: 'AWS::IAM::Policy',
      properties: {
        PolicyDocument: {
          Statement: [
            ...secretReadStatements(secretArns),
            { Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Effect: 'Allow', Resource: getAtt(logGroup, 'Arn') },
          ],
          Version: '2012-10-17',
        },
        PolicyName: execPolicy,
        Roles: [ref(execRole)],
      },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-role',
      cfnType: 'AWS::IAM::Role',
      properties: {
        AssumeRolePolicyDocument: { Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' } }], Version: '2012-10-17' },
        Description: 'Runtime role for the customer application container.',
        Path: '/deployz/',
        Tags: tags(componentId),
      },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-role-policy',
      cfnType: 'AWS::IAM::Policy',
      properties: {
        PolicyDocument: {
          Statement: [
            {
              Action: ['s3:GetObject*', 's3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutObject', 's3:PutObjectLegalHold', 's3:PutObjectRetention', 's3:PutObjectTagging', 's3:PutObjectVersionTagging', 's3:Abort*'],
              Effect: 'Allow',
              Resource: [getAtt(logicalResourceId('storage', 'bucket'), 'Arn'), join('', [getAtt(logicalResourceId('storage', 'bucket'), 'Arn'), '/*'])],
            },
            ...secretReadStatements(secretArns),
          ],
          Version: '2012-10-17',
        },
        PolicyName: taskPolicy,
        Roles: [ref(taskRole)],
      },
    }),
  ];
}

/** Task definition + service + security group for one web workload. */
function compileWebService(ctx: EcsContext, workload: IrWorkload, profile: InfrastructureSizeProfile, targetGroup: string, listener: string): ResolvedResource[] {
  const componentId = workload.componentId;
  const logGroup = logicalResourceId(componentId, 'log-group');
  const execRole = logicalResourceId(componentId, 'task-execution-role');
  const taskRole = logicalResourceId(componentId, 'task-role');
  const taskDef = logicalResourceId(componentId, 'task-definition');
  const serviceSg = logicalResourceId(componentId, 'service-security-group');

  const environment: unknown[] = [
    { Name: 'NODE_ENV', Value: 'production' },
    { Name: 'PORT', Value: ref('paramContainerPort') },
  ];
  const secrets: unknown[] = [
    { Name: 'APP_API_KEY', ValueFrom: join('', [ref(logicalResourceId('application', 'config-secret')), ':apiKey::']) },
    { Name: 'APP_SIGNING_SECRET', ValueFrom: join('', [ref(logicalResourceId('application', 'config-secret')), ':signingSecret::']) },
  ];
  if (ctx.db !== undefined) {
    environment.push(
      { Name: 'DATABASE_HOST', Value: getAtt(ctx.db.instance, 'Endpoint.Address') },
      { Name: 'DATABASE_PORT', Value: String(DB_PORT) },
      { Name: 'DATABASE_NAME', Value: DB_NAME },
      { Name: 'DATABASE_USER', Value: DB_USER },
    );
    secrets.push(
      { Name: 'DATABASE_PASSWORD', ValueFrom: join('', [ref(ctx.db.secret), ':password::']) },
      { Name: 'DATABASE_URL', ValueFrom: ref(ctx.db.urlSecret) },
    );
    environment.push(
      { Name: 'NODE_EXTRA_CA_CERTS', Value: RDS_CA_BUNDLE_PATH },
      { Name: 'PGSSLROOTCERT', Value: RDS_CA_BUNDLE_PATH },
    );
  }
  environment.push(
    { Name: 'STORAGE_BUCKET', Value: ref(logicalResourceId('storage', 'bucket')) },
    { Name: 'S3_BUCKET', Value: ref(logicalResourceId('storage', 'bucket')) },
    { Name: 'AWS_S3_BUCKET', Value: ref(logicalResourceId('storage', 'bucket')) },
    { Name: 'AWS_REGION', Value: ref('AWS::Region') },
  );
  if (ctx.cache !== undefined) {
    environment.push(
      { Name: 'REDIS_URL', Value: join('', ['redis://', getAtt(ctx.cache.replicationGroup, 'PrimaryEndPoint.Address'), `:${REDIS_PORT}`]) },
      { Name: 'REDIS_HOST', Value: getAtt(ctx.cache.replicationGroup, 'PrimaryEndPoint.Address') },
      { Name: 'REDIS_PORT', Value: String(REDIS_PORT) },
    );
  }

  const containerDefs: unknown[] = [{
    Name: 'App',
    Essential: true,
    Image: ref('paramImageReference'),
    PortMappings: [{ ContainerPort: ref('paramContainerPort'), Protocol: 'tcp' }],
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': ref(logGroup), 'awslogs-stream-prefix': 'deployz-app', 'awslogs-region': ref('AWS::Region') } },
    Environment: environment,
    Secrets: secrets,
    ...(ctx.db !== undefined
      ? {
          DependsOn: [{ Condition: 'SUCCESS', ContainerName: 'RdsCaBundle' }],
          MountPoints: [{ ContainerPath: RDS_CA_DIR, ReadOnly: true, SourceVolume: RDS_CA_VOLUME }],
        }
      : {}),
  }];

  if (ctx.db !== undefined) {
    containerDefs.push({
      Name: 'RdsCaBundle',
      Essential: false,
      Image: RDS_CA_INIT_IMAGE,
      Command: ['sh', '-c', join('', [`curl -fsSL "https://truststore.pki.rds.amazonaws.com/`, ref('AWS::Region'), `/`, ref('AWS::Region'), `-bundle.pem" -o ${RDS_CA_BUNDLE_PATH} || echo "RDS CA bundle fetch failed; the application starts without it"`])],
      LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': ref(logGroup), 'awslogs-stream-prefix': 'deployz-rds-ca', 'awslogs-region': ref('AWS::Region') } },
      MountPoints: [{ ContainerPath: RDS_CA_DIR, ReadOnly: false, SourceVolume: RDS_CA_VOLUME }],
    });
  }

  const out: ResolvedResource[] = [
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-definition',
      cfnType: 'AWS::ECS::TaskDefinition',
      properties: {
        ContainerDefinitions: containerDefs,
        Cpu: String(profile.workload.cpuUnits),
        ExecutionRoleArn: getAtt(execRole, 'Arn'),
        Family: `DeployzApp${pascal(componentId)}`,
        Memory: String(profile.workload.memoryMiB),
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
        Tags: tags(componentId),
        TaskRoleArn: getAtt(taskRole, 'Arn'),
        ...(ctx.db !== undefined ? { Volumes: [{ Name: RDS_CA_VOLUME }] } : {}),
      },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'service-security-group',
      cfnType: 'AWS::EC2::SecurityGroup',
      properties: { GroupDescription: `DeployzApp/${componentId}/SecurityGroup`, SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default', IpProtocol: '-1' }], Tags: tags(componentId), VpcId: ref(ctx.ids.vpc) },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'service',
      cfnType: 'AWS::ECS::Service', verificationCheck: 'compute',
      properties: {
        Cluster: ref(logicalResourceId(componentId, 'cluster')),
        DeploymentConfiguration: {
          Alarms: { AlarmNames: [], Enable: false, Rollback: false },
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
          MaximumPercent: 200,
          MinimumHealthyPercent: 100,
        },
        DeploymentController: { Type: 'ECS' },
        DesiredCount: ref('paramDesiredCount'),
        EnableECSManagedTags: false,
        HealthCheckGracePeriodSeconds: 60,
        LaunchType: 'FARGATE',
        LoadBalancers: [{ ContainerName: 'App', ContainerPort: ref('paramContainerPort'), TargetGroupArn: ref(targetGroup) }],
        NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED', SecurityGroups: [getAtt(serviceSg, 'GroupId')], Subnets: [ref(ctx.ids.privateSubnets[0]), ref(ctx.ids.privateSubnets[1])] } },
        Tags: tags(componentId),
        TaskDefinition: ref(taskDef),
      },
      dependsOn: [targetGroup, listener, logicalResourceId(componentId, 'task-role-policy'), logicalResourceId(componentId, 'task-role')],
    }),
  ];

  return out;
}

/** ALB + listener + target group + alarm + ingress — for public workloads. */
function compileAlb(ctx: EcsContext, workload: IrWorkload): ResolvedResource[] {
  const componentId = 'endpoint';
  const alb = logicalResourceId(componentId, 'load-balancer');
  const albSg = logicalResourceId(componentId, 'load-balancer-security-group');
  const targetGroup = logicalResourceId(componentId, 'target-group');
  const serviceSg = logicalResourceId(workload.componentId, 'service-security-group');

  return [
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'load-balancer-security-group',
      cfnType: 'AWS::EC2::SecurityGroup',
      properties: {
        GroupDescription: 'Automatically created Security Group for the application load balancer',
        SecurityGroupIngress: [
          { CidrIp: '0.0.0.0/0', Description: 'HTTPS for a custom domain attached after install', FromPort: 443, IpProtocol: 'tcp', ToPort: 443 },
          { CidrIp: '0.0.0.0/0', Description: 'Allow from anyone on port 80', FromPort: 80, IpProtocol: 'tcp', ToPort: 80 },
        ],
        Tags: tags(componentId),
        VpcId: ref(ctx.ids.vpc),
      },
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'load-balancer',
      cfnType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', verificationCheck: 'ingress',
      properties: {
        LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
        Scheme: 'internet-facing',
        SecurityGroups: [getAtt(albSg, 'GroupId')],
        Subnets: [ref(ctx.ids.publicSubnets[0]), ref(ctx.ids.publicSubnets[1])],
        Tags: tags(componentId),
        Type: 'application',
      },
      dependsOn: [
        logicalResourceId('network', 'public-route-1'),
        logicalResourceId('network', 'public-route-table-association-1'),
        logicalResourceId('network', 'public-route-2'),
        logicalResourceId('network', 'public-route-table-association-2'),
      ],
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'target-group',
      cfnType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      properties: {
        HealthCheckPath: ref('paramHealthCheckPath'),
        Port: ref('paramContainerPort'),
        Protocol: 'HTTP',
        Tags: tags(componentId),
        TargetGroupAttributes: [{ Key: 'stickiness.enabled', Value: 'false' }],
        TargetType: 'ip',
        VpcId: ref(ctx.ids.vpc),
      },
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'http-listener',
      cfnType: 'AWS::ElasticLoadBalancingV2::Listener',
      properties: {
        DefaultActions: [{ TargetGroupArn: ref(targetGroup), Type: 'forward' }],
        LoadBalancerArn: ref(alb),
        Port: 80,
        Protocol: 'HTTP',
        Tags: tags(componentId),
      },
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'load-balancer-to-service-ingress',
      cfnType: 'AWS::EC2::SecurityGroupIngress',
      properties: { Description: 'Load balancer to target', FromPort: ref('paramContainerPort'), GroupId: getAtt(serviceSg, 'GroupId'), IpProtocol: 'tcp', SourceSecurityGroupId: getAtt(albSg, 'GroupId'), ToPort: ref('paramContainerPort') },
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'load-balancer-to-service-egress',
      cfnType: 'AWS::EC2::SecurityGroupEgress',
      properties: { Description: 'Load balancer to target', DestinationSecurityGroupId: getAtt(serviceSg, 'GroupId'), FromPort: ref('paramContainerPort'), GroupId: getAtt(albSg, 'GroupId'), IpProtocol: 'tcp', ToPort: ref('paramContainerPort') },
    }),
    res({
      componentId, componentKind: 'monitoring', capability: CAPABILITY_KEYS.ALB, resourceRole: 'unhealthy-target-alarm',
      cfnType: 'AWS::CloudWatch::Alarm',
      properties: {
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        DatapointsToAlarm: 3,
        Dimensions: [
          { Name: 'LoadBalancer', Value: getAtt(alb, 'LoadBalancerFullName') },
          { Name: 'TargetGroup', Value: getAtt(targetGroup, 'TargetGroupFullName') },
        ],
        EvaluationPeriods: 3,
        MetricName: 'UnHealthyHostCount',
        Namespace: 'AWS/ApplicationELB',
        Period: 60,
        Statistic: 'Average',
        Threshold: 1,
        TreatMissingData: 'notBreaching',
      },
    }),
  ];
}

// ── Parameters / outputs / conditions ───────────────────────────────────────

function compileParameters(): ResolvedParameter[] {
  return [
    { id: 'paramDesiredCount', type: 'Number', noEcho: false, defaultValue: '1', description: 'Number of application tasks the service starts with. 0 defers the first start to the configured deploy that follows the install.' },
    { id: 'paramImageReference', type: 'String', noEcho: false, defaultValue: `${DEFAULT_IMAGE_REPOSITORY}@${DEFAULT_IMAGE_DIGEST}`, description: 'Container image reference (repository@sha256:...) the application task definitions run.' },
    { id: 'paramContainerPort', type: 'Number', noEcho: true, defaultValue: String(APP_PORT), description: 'TCP port the application container listens on.' },
    { id: 'paramHealthCheckPath', type: 'String', noEcho: true, defaultValue: HEALTH_CHECK_PATH, description: 'Path the ALB target group and container health checks probe.' },
    { id: 'paramAppApiKey', type: 'String', noEcho: true, defaultValue: '', description: 'Application API key (vendor/customer secret).' },
    { id: 'paramAppSigningSecret', type: 'String', noEcho: true, defaultValue: '', description: 'Application signing secret (vendor/customer secret).' },
  ];
}

function compileOutputs(ctx: { hasDb: boolean; db: { instance: string; secret: string } | undefined; hasRedis: boolean; cache: { replicationGroup: string } | undefined }): ResolvedOutput[] {
  const outputs: ResolvedOutput[] = [];
  if (ctx.hasDb && ctx.db !== undefined) {
    outputs.push({ id: 'DbHost', value: getAtt(ctx.db.instance, 'Endpoint.Address') });
    outputs.push({ id: 'DbSecretArn', value: ref(ctx.db.secret) });
  }
  outputs.push({ id: 'StorageBucketName', value: ref(logicalResourceId('storage', 'bucket')) });
  outputs.push({ id: 'ClusterName', value: ref(logicalResourceId('web', 'cluster')) });
  outputs.push({ id: 'PublicEndpoint', value: getAtt(logicalResourceId('endpoint', 'load-balancer'), 'DNSName') });
  if (ctx.hasRedis && ctx.cache !== undefined) {
    outputs.push({ id: 'CacheEndpoint', value: getAtt(ctx.cache.replicationGroup, 'PrimaryEndPoint.Address') });
  }
  return outputs;
}

function pascal(token: string): string {
  return token
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface CompileInput {
  readonly ir: DeployzIR;
  readonly region: Region | null;
  readonly sizeProfile?: InfrastructureSizeProfile;
}

export interface CompiledGraph {
  readonly graph: ResolvedAwsGraph;
  readonly compilerVersion: string;
  readonly capabilityRegistryVersion: string;
  readonly region: Region | null;
}

/** The primary web workload (single web workload in the MVP). */
function webWorkload(ir: DeployzIR): IrWorkload {
  const web = ir.workloads.find((w) => w.kind === 'web') ?? ir.workloads[0];
  if (web === undefined) {
    throw new Error('compiler: DeployzIR has no workload to compile');
  }
  return web;
}

function resourceByCapability(ir: DeployzIR, key: string): IrResource | undefined {
  return ir.resources.find((r) => r.capabilityKey === key);
}

export function compileInfrastructure(input: CompileInput): CompiledGraph {
  const { ir, region } = input;
  const profile = input.sizeProfile ?? defaultInfrastructureSizeProfile();

  const dbResource = resourceByCapability(ir, CAPABILITY_KEYS.RDS_POSTGRES);
  const cacheResource = resourceByCapability(ir, CAPABILITY_KEYS.ELASTICACHE_VALKEY);
  const workload = webWorkload(ir);

  const ids = netIds();

  // Resolve the db/cache context before ECS so the task definition can bind
  // to the endpoint/secret logical ids.
  const db = dbResource !== undefined
    ? {
        componentId: dbResource.componentId,
        secret: logicalResourceId(dbResource.componentId, 'master-secret'),
        urlSecret: logicalResourceId(dbResource.componentId, 'url-secret'),
        instance: logicalResourceId(dbResource.componentId, 'instance'),
      }
    : undefined;
  const cache = cacheResource !== undefined
    ? {
        componentId: cacheResource.componentId,
        replicationGroup: logicalResourceId(cacheResource.componentId, 'replication-group'),
      }
    : undefined;

  const ctx: EcsContext = { ids, hasDb: db !== undefined, hasRedis: cache !== undefined, db, cache };

  const targetGroup = logicalResourceId('endpoint', 'target-group');
  const listener = logicalResourceId('endpoint', 'http-listener');

  const resources: ResolvedResource[] = [
    ...compileNetwork(ids),
    compileAppSecret(),
    ...compileS3(),
    compileLogGroup(),
    ...(dbResource !== undefined ? compileRdsPostgres(dbResource, profile, ids, logicalResourceId(workload.componentId, 'service-security-group')) : []),
    ...(cacheResource !== undefined ? compileElasticache(cacheResource, profile, ids) : []),
    ...compileEcsShared(ctx, workload),
    ...compileWebService(ctx, workload, profile, targetGroup, listener),
    ...compileAlb(ctx, workload),
  ];

  const violations = logicalIdViolations(resources.map((r) => r.logicalId));
  if (violations.length > 0) {
    throw new Error(`compiler: logical id violations:\n${violations.join('\n')}`);
  }

  const graph: ResolvedAwsGraph = {
    resources,
    parameters: compileParameters(),
    outputs: compileOutputs({ hasDb: db !== undefined, db, hasRedis: cache !== undefined, cache }),
    conditions: [] as ResolvedCondition[],
  };

  return {
    graph,
    compilerVersion: COMPILER_VERSION,
    capabilityRegistryVersion: ir.metadata.capabilityRegistryVersion,
    region,
  };
}

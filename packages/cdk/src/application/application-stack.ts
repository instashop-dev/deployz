/**
 * Application stack — the infrastructure that RUNS a customer's deployed
 * application, provisioned into the CUSTOMER's AWS account AFTER the bootstrap
 * stack (todo 8) establishes the relay trust channel and the relay makes its
 * first contact.
 *
 * This is the versioned runtime template (runtime-v1) referenced by §59/§60:
 * infra changes flow through a controlled lifecycle (runtime-v1 → v2), never a
 * silent template mutation. It is DISTINCT from the control-plane DeployzStack
 * (todo 7) and the bootstrap BootstrapStack (todo 8).
 *
 * What it provisions, in order of the plan's todo 9 scope:
 *   1. VPC          — 2 AZs, public + private subnets, NAT gateway.
 *   2. ALB          — internet-facing Application Load Balancer (plain-Fargate
 *                     mode) with a `/health` health check; in Express mode the
 *                     ALB/target-group/security-group set is auto-managed by
 *                     `AWS::ECS::ExpressGatewayService`. §9 supports "public
 *                     HTTPS application endpoints": when `certificateArn` is
 *                     supplied, an HTTPS:443 listener is added and HTTP:80
 *                     redirects to it. Without a certificate, synth throws
 *                     unless `allowInsecureHttp: true` explicitly opts into
 *                     plain HTTP (non-production only) — there is no silent
 *                     HTTP-only fallback.
 *   3. ECS Fargate  — an `expressMode` boolean prop selects the deployment
 *                     model (C3/U3):
 *                       - expressMode=false (DEFAULT): plain Fargate
 *                         (FargateTaskDefinition + FargateService) with an
 *                         explicit ALB — the safe, everywhere-available
 *                         fallback.
 *                       - expressMode=true: ECS Express Mode
 *                         (`AWS::ECS::ExpressGatewayService`), the fast-scaling
 *                         service mode where ECS manages the ALB/target
 *                         groups/security groups/auto-scaling.
 *   4. RDS PostgreSQL — db.t4g.micro, Postgres 16, private subnet group,
 *                     automated backups (§64), final-snapshot on delete.
 *   5. S3           — versioned application object storage, deployz:-tagged.
 *   6. Secrets Manager — DB master credentials (bootstrap-generated, NOT a
 *                     parameter) + app env secrets supplied via NoEcho params.
 *   7. CloudWatch   — ECS task log group with retention.
 *   8. NoEcho/param_ params — app env secrets are template parameters with
 *                     NoEcho=true and a `param_` name prefix (M17). The DB
 *                     password is never a parameter (it is generated).
 */
import {
  CfnCondition,
  CfnParameter,
  Duration,
  Fn,
  Lazy,
  RemovalPolicy,
  SecretValue,
  Stack,
  Tags,
  Token,
  type StackProps,
} from 'aws-cdk-lib';
import { TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
  type IVpc,
} from 'aws-cdk-lib/aws-ec2';
import {
  CfnExpressGatewayService,
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  OperatingSystemFamily,
  Protocol,
  Secret as EcsSecret,
  type ICluster,
} from 'aws-cdk-lib/aws-ecs';
import { CfnReplicationGroup, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
  ListenerCertificate,
  type ApplicationTargetGroup,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from 'aws-cdk-lib/aws-rds';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from 'aws-cdk-lib/aws-s3';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { resolveRedisEnvBindings } from '@deployz/analysis';

/** One install-time NoEcho parameter surfaced to the container as an ECS secret. */
export interface SecretParameterSpec {
  /** CfnParameter construct id. Must use the `param_` prefix (M17 NoEcho invariant). */
  readonly parameterId: string;
  /** JSON key inside the app config secret that stores the parameter value. */
  readonly secretKey: string;
  /** Environment variable name injected into the container at task start. */
  readonly envName: string;
  /**
   * When the parameter arrives empty (no custom domain configured before
   * install), fall back to `http://<load balancer DNS>` inside the template
   * instead of shipping an empty string — an app that derives cookies or
   * redirects from this URL cannot boot on ''. Plain-Fargate mode only; in
   * express mode ECS manages the ALB and its DNS is not referencable here,
   * so the raw parameter value is used unchanged.
   */
  readonly fallbackToLoadBalancerUrl?: boolean;
}

export interface ApplicationStackProps extends StackProps {
  /**
   * Selects the ECS deployment model (C3/U3).
   *
   * `false` (default) provisions plain Fargate — a `FargateTaskDefinition` +
   * `FargateService` behind an explicit Application Load Balancer. This is the
   * safe fallback: it is available in every supported region and does not
   * depend on the newer Express service mode.
   *
   * `true` provisions ECS Express Mode (`AWS::ECS::ExpressGatewayService`),
   * where ECS manages the ALB, target groups, security groups and auto-scaling
   * for fast-scaling web applications.
   */
  readonly expressMode?: boolean;
  /**
   * Container image repository (without a tag). Combined with `imageDigest` to
   * form an immutable `repo@sha256:...` reference. The release's exact digest
   * is pinned per template version (§59/§60), so a placeholder is safe for the
   * committed runtime-v1 artifact and overridden at release time.
   */
  readonly imageRepository?: string;
  /** Container image digest (immutable `sha256:` reference). */
  readonly imageDigest?: string;
  /** Number of tasks to run (plain Fargate desiredCount / Express minTaskCount). */
  readonly desiredCount?: number;
  /**
   * Command override for a background worker container.
   *
   * When provided, a second `FargateTaskDefinition` + `FargateService` is
   * created for the worker. The worker uses the same ECR image, Secrets Manager
   * secrets, and S3 bucket as the web service, but runs in private subnets
   * only with no load balancer. Only applies in plain Fargate mode
   * (`expressMode` is false) — `expressMode: true` combined with a
   * `workerCommand` is a synth-time validation error (§8.1: an unsupported
   * configuration fails loudly rather than silently dropping the worker).
   */
  readonly workerCommand?: string;
  /** Deployz application identifier — applied as `deployz:application` tag. */
  readonly applicationId?: string;
  /** Deployz vendor identifier — applied as `deployz:vendor` tag. */
  readonly vendorId?: string;
  /**
   * Deployz installation identifier — applied as `deployz:installation` tag
   * (§15) alongside `deployz:application` and `deployz:vendor` for
   * predictable resource identification.
   */
  readonly installationId?: string;
  /**
   * Domain name for the HTTPS listener.
   *
   * Informational only; the actual TLS termination uses `certificateArn`.
   */
  readonly domainName?: string;
  /**
   * ACM certificate ARN for the HTTPS listener on port 443.
   *
   * When provided, an HTTPS listener is added with this certificate and the
   * HTTP listener on port 80 is configured to redirect to HTTPS.
   */
  readonly certificateArn?: string;
  /**
   * Explicit opt-in to serve plain HTTP with no TLS termination, when
   * `certificateArn` is not supplied.
   *
   * §9 lists "public HTTPS application endpoints" as the supported contract
   * — plain HTTP is NOT a silent fallback. This flag exists for local/dev
   * use only; it is NOT intended for production traffic. Synth throws if
   * `certificateArn` is absent and this is not explicitly `true`.
   */
  readonly allowInsecureHttp?: boolean;
  /**
   * Provision a private single-node ElastiCache Valkey cache (Redis MVP,
   * spec §13-18) alongside the application.
   *
   * `false` (default) provisions zero ElastiCache resources and injects no
   * `REDIS_*` container env — existing non-Redis deployments synth
   * byte-identical infrastructure.
   *
   * `true` provisions a `cache.t4g.micro`, single-node, standalone `valkey`
   * cache over the same private subnets RDS uses, plus a dedicated security
   * group, and injects the resolved `REDIS_*` env vars into both the app and
   * (when present) worker containers.
   */
  readonly redisRequired?: boolean;
  /**
   * Detected Redis connection env var names (`RedisRequirement.connectionEnvVars`
   * from `@deployz/analysis`). Resolved via `resolveRedisEnvBindings` into the
   * concrete env vars injected into the container — a `url`-kind binding gets
   * the full `redis://host:6379` connection string, `host`/`port`-kind
   * bindings get just the endpoint address / literal port.
   *
   * When omitted or empty, the three Deployz defaults are injected:
   * `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`.
   */
  readonly redisEnvVars?: string[];
  /**
   * Provision a managed RDS PostgreSQL instance for the application.
   *
   * `true` (default) provisions the db.t4g.micro Postgres 16 instance, its
   * security group, the generated master-credential secret, the `DATABASE_*`
   * container env vars/secrets, and the DbHost/DbSecretArn stack outputs —
   * the existing behavior, byte-identical synth.
   *
   * `false` provisions zero RDS resources, no `DATABASE_*` env vars or
   * secrets, and no DB outputs. Use for apps analysed as
   * `databaseState === 'none'` (no database detected).
   */
  readonly databaseRequired?: boolean;
  /**
   * Container port the application listens on.
   *
   * Drives the ECS container port mapping, the `PORT` env var, the container
   * health-check URL, and the `AppTargets` ALB target group port (in both the
   * HTTP-only and HTTPS+redirect listener branches).
   *
   * Defaults to 3000 — the existing behavior, byte-identical synth.
   */
  readonly containerPort?: number;
  /**
   * HTTP path the container health check and the `AppTargets` ALB target
   * group health check probe.
   *
   * Defaults to `/health` — the existing behavior, byte-identical synth.
   */
  readonly healthCheckPath?: string;
  /**
   * Plain (non-secret) environment variables injected into the App
   * container, the Express `primaryContainer`, and the worker container —
   * same parity pattern as the Redis `REDIS_*` env vars.
   *
   * Omitted or empty by default — no additional env vars, byte-identical
   * synth.
   */
  readonly containerEnvironment?: Readonly<Record<string, string>>;
  /**
   * Additional install-time NoEcho parameters surfaced to the container as
   * ECS secrets, beyond the two built-in `param_AppApiKey`/
   * `param_AppSigningSecret` parameters.
   *
   * Each entry creates a `param_`-prefixed NoEcho `CfnParameter`, writes its
   * value into `appSecret` under `secretKey`, and injects it into the App
   * container, the Express `primaryContainer`, and the worker container as
   * an ECS secret named `envName`.
   *
   * Omitted or empty by default — no additional parameters or secrets,
   * byte-identical synth.
   */
  readonly secretParameters?: readonly SecretParameterSpec[];
  /**
   * Environment variable names that each receive the complete PostgreSQL
   * connection URL as a whole-value ECS secret (Documenso needs the same
   * URL under two names: `NEXT_PRIVATE_DATABASE_URL` and
   * `NEXT_PRIVATE_DIRECT_DATABASE_URL`).
   *
   * Requires `databaseRequired` to be true — synth throws if this is non-empty
   * with `databaseRequired: false`. When non-empty and valid, a second Secrets
   * Manager secret is created holding the assembled `postgresql://` URL —
   * built at deploy time from the generated master credentials via a
   * CloudFormation dynamic reference, so the password never appears in the
   * template or task definition. Injected into the App container, the
   * Express `primaryContainer`, and the worker container — same parity
   * pattern as `secretParameters`.
   *
   * Omitted or empty by default — no second secret, byte-identical synth.
   */
  readonly databaseUrlEnvNames?: readonly string[];
  /**
   * Shell command run by the plain-Fargate App container's health check, in
   * place of the default
   * `curl -f http://localhost:<containerPort><healthCheckPath> || exit 1`.
   *
   * Applies to the plain-Fargate web container only — the Express branch has
   * no container health check.
   */
  readonly healthCheckShellCommand?: string;
  /**
   * Task-level CPU units for the plain-Fargate web task definition.
   *
   * Applies to the plain-Fargate web service only — Express mode and the
   * background worker keep their own fixed values.
   *
   * Defaults to 256 — the existing behavior, byte-identical synth.
   */
  readonly taskCpu?: number;
  /**
   * Task-level memory (MiB) for the plain-Fargate web task definition.
   *
   * Applies to the plain-Fargate web service only, per `taskCpu` above.
   *
   * Defaults to 512 — the existing behavior, byte-identical synth.
   */
  readonly taskMemoryMiB?: number;
  /**
   * Seconds the plain-Fargate App container's health check waits before
   * counting failures (container `HealthCheck.StartPeriod`).
   *
   * When explicitly set, also sets `healthCheckGracePeriod` on the
   * plain-Fargate `FargateService` so ECS gives the service the same grace
   * period before acting on failing health checks. Left unset, the service
   * keeps its CDK-derived default grace period — the existing behavior.
   *
   * Defaults to 60 — the existing behavior, byte-identical synth.
   */
  readonly startupGracePeriodSeconds?: number;
}

const DEFAULT_IMAGE_REPOSITORY = 'public.ecr.aws/deployz/fixture';
const DEFAULT_IMAGE_DIGEST =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const APP_PORT = 3000;
const HEALTH_CHECK_PATH = '/health';
const DB_NAME = 'deployz';
const DB_USER = 'deployz_app';
const DB_PORT = 5432;
const REDIS_ENGINE = 'valkey';
const REDIS_NODE_TYPE = 'cache.t4g.micro';
const REDIS_PORT = 6379;

export class ApplicationStack extends Stack {
  public readonly vpc: Vpc;
  /** RDS PostgreSQL instance (defined when `databaseRequired` is true). */
  public readonly database?: DatabaseInstance;
  /** DB master credentials — generated at deploy time, never a parameter. */
  public readonly databaseSecret?: Secret;
  /**
   * Complete PostgreSQL connection URL (defined when `databaseUrlEnvNames`
   * is non-empty). Assembled at deploy time from the generated master
   * credentials via a CloudFormation dynamic reference — the password never
   * appears in the template.
   */
  public readonly databaseUrlSecret?: Secret;
  /** App runtime secrets — supplied via NoEcho `param_` parameters (M17). */
  public readonly appSecret: Secret;
  public readonly storageBucket: Bucket;
  public readonly cluster: Cluster;
  /** Plain-Fargate service (defined when `expressMode` is false). */
  public readonly fargateService?: FargateService;
  /** Express Gateway service (defined when `expressMode` is true). */
  public readonly expressService?: CfnExpressGatewayService;
  /** Explicit ALB (defined when `expressMode` is false). */
  public readonly loadBalancer?: ApplicationLoadBalancer;
  /** Background worker service (defined when `workerCommand` is provided). */
  public readonly workerService?: FargateService;
  /** Background worker log group (defined when `workerCommand` is provided). */
  public readonly workerLogGroup?: LogGroup;
  /** ElastiCache Valkey cache (defined when `redisRequired` is true). */
  public readonly cache?: CfnReplicationGroup;

  constructor(scope: Construct, id: string, props: ApplicationStackProps = {}) {
    super(scope, id, props);

    const expressMode = props.expressMode ?? false;
    const imageRepository = props.imageRepository ?? DEFAULT_IMAGE_REPOSITORY;
    const imageDigest = props.imageDigest ?? DEFAULT_IMAGE_DIGEST;
    const desiredCount = props.desiredCount ?? 1;
    const imageReference = `${imageRepository}@${imageDigest}`;
    const databaseRequired = props.databaseRequired ?? true;
    const containerPort = props.containerPort ?? APP_PORT;
    const healthCheckPath = props.healthCheckPath ?? HEALTH_CHECK_PATH;
    const containerEnvEntries: Array<[string, string]> = Object.entries(
      props.containerEnvironment ?? {},
    );

    // ── §8.1 validation: unsupported configuration combinations fail loudly ──
    // ECS Express Mode does not support a separate background worker service
    // (the worker branch below only exists in the plain-Fargate `else` arm).
    // Rather than silently dropping the worker when both are requested,
    // reject the configuration at synth time.
    if (expressMode && props.workerCommand !== undefined) {
      throw new Error(
        'ApplicationStack: workerCommand is not supported when expressMode is true. ' +
          'ECS Express Mode has no background worker service — set expressMode to ' +
          'false (plain Fargate) to run a worker alongside the web service.',
      );
    }

    // §9/§11: "public HTTPS application endpoints" is the supported contract.
    // Plain HTTP is not a silent fallback — require an explicit opt-in when
    // no certificate is supplied.
    if (props.certificateArn === undefined && props.allowInsecureHttp !== true) {
      throw new Error(
        'ApplicationStack: certificateArn is required for a public HTTPS endpoint (§9). ' +
          'Pass allowInsecureHttp: true to explicitly opt in to plain HTTP ' +
          '(non-production use only) if you do not have a certificate yet.',
      );
    }

    if ((props.databaseUrlEnvNames?.length ?? 0) > 0 && !databaseRequired) {
      throw new Error(
        'ApplicationStack: databaseUrlEnvNames requires databaseRequired to be true. ' +
          'The connection URL is assembled from the managed RDS instance and its ' +
          'generated credentials — without a database there is no URL to inject.',
      );
    }

    // ── 1. VPC: 2 AZs, public + private subnets, NAT gateway ─────────────
    this.vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: SubnetType.PUBLIC },
        { name: 'Private', subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // ── 8. NoEcho / param_ parameters (M17) ───────────────────────────────
    // App env secrets are vendor/customer config (§31). They arrive as template
    // parameters with NoEcho=true and a `param_` prefix (CloudFormation's
    // Quick Create convention for URL-suppliable params). The values are never
    // echoed back; they land in Secrets Manager and are injected into the
    // container at task start. The DB password is NOT here — it is generated.
    //
    // Both default to empty, because at INSTALL time there is nothing to put
    // in them: a deployment has no release and no vendor configuration until
    // after it is installed, and CONFIG_UPDATE is what supplies these later.
    // Without a default, CloudFormation rejects the create outright —
    // "Parameters: [paramAppApiKey, paramAppSigningSecret] must have values"
    // — so an install could never happen at all. An empty secret honestly
    // says "not configured yet"; a required parameter with no possible value
    // says nothing and blocks everything.
    const appApiKeyParam = new CfnParameter(this, 'param_AppApiKey', {
      type: 'String',
      noEcho: true,
      default: '',
      description:
        'Application API key (vendor/customer secret). NoEcho — never echoed.',
    });
    const appSigningSecretParam = new CfnParameter(this, 'param_AppSigningSecret', {
      type: 'String',
      noEcho: true,
      default: '',
      description:
        'Application signing secret (vendor/customer secret). NoEcho — never echoed.',
    });
    // Additional vendor-supplied secrets (secretParameters), same NoEcho/
    // empty-default convention as the two built-in parameters above.
    const secretParams = (props.secretParameters ?? []).map((spec) => ({
      spec,
      param: new CfnParameter(this, spec.parameterId, {
        type: 'String',
        noEcho: true,
        default: '',
        description: `Application secret (vendor/customer config) for ${spec.envName}. NoEcho — never echoed.`,
      }),
    }));

    // ── 6. Secrets Manager ────────────────────────────────────────────────
    // DB master credentials: bootstrap-generated (generateStringKey), never a
    // template parameter, never in the Quick Create URL. Skipped entirely when
    // the app has no database (databaseRequired is false).
    if (databaseRequired) {
      this.databaseSecret = new Secret(this, 'DatabaseSecret', {
        description:
          'RDS PostgreSQL master credentials for the customer application. ' +
          'Generated by CloudFormation at deploy time — never a template parameter.',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: DB_USER }),
          generateStringKey: 'password',
          passwordLength: 32,
          // Alphanumeric only. The password is embedded verbatim in a
          // postgresql:// connection URL (DatabaseUrlSecret below) via a
          // CloudFormation dynamic reference — percent-encoding cannot
          // happen inside a dynamic reference, so URL-reserved punctuation
          // would corrupt the URL. RDS separately forbids '/@" ' in a
          // MasterUserPassword anyway (a live install died on exactly that,
          // rolling the whole stack back minutes in); alphanumeric-only
          // satisfies both constraints at once.
          excludePunctuation: true,
        },
      });
    }

    // App runtime secrets: the NoEcho parameter values are written into this
    // secret at deploy time (§31 write-through: secret values live in the
    // customer account, never in the control plane).
    //
    // fallbackToLoadBalancerUrl specs resolve through an Fn::If: the
    // parameter when provided, otherwise the ALB's own URL. The condition is
    // created eagerly (it only involves the parameter); the value string is
    // Lazy because the load balancer construct does not exist yet here.
    const lbFallbackConditions = new Map<string, CfnCondition>(
      props.expressMode === true
        ? []
        : secretParams
            .filter(({ spec }) => spec.fallbackToLoadBalancerUrl === true)
            .map(({ spec, param }) => [
              spec.parameterId,
              new CfnCondition(this, `${spec.parameterId}Provided`, {
                expression: Fn.conditionNot(Fn.conditionEquals(param.valueAsString, '')),
              }),
            ]),
    );
    const secretParamValue = (spec: SecretParameterSpec, param: CfnParameter): SecretValue => {
      const condition = lbFallbackConditions.get(spec.parameterId);
      if (condition === undefined) return SecretValue.cfnParameter(param);
      return SecretValue.unsafePlainText(
        Lazy.string({
          produce: () =>
            this.loadBalancer === undefined
              ? param.valueAsString
              : Token.asString(
                  Fn.conditionIf(
                    condition.logicalId,
                    param.valueAsString,
                    `http://${this.loadBalancer.loadBalancerDnsName}`,
                  ),
                ),
        }),
      );
    };
    this.appSecret = new Secret(this, 'AppConfigSecret', {
      description:
        'Application runtime secrets (vendor/customer config) supplied via ' +
        'NoEcho parameters at deploy time. Never returned to the control plane.',
      secretObjectValue: {
        apiKey: SecretValue.cfnParameter(appApiKeyParam),
        signingSecret: SecretValue.cfnParameter(appSigningSecretParam),
        ...Object.fromEntries(
          secretParams.map(({ spec, param }) => [spec.secretKey, secretParamValue(spec, param)]),
        ),
      },
    });

    // ── 5. S3 object storage (versioned) ─────────────────────────────────
    this.storageBucket = new Bucket(this, 'AppStorage', {
      versioned: true,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── 7. CloudWatch log group for ECS tasks ─────────────────────────────
    const logGroup = new LogGroup(this, 'AppLogGroup', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ── 4. RDS PostgreSQL ─────────────────────────────────────────────────
    // Gated on databaseRequired: when false, zero RDS resources, no DB
    // security group, no DATABASE_* env vars injected below — the template
    // stays free of any database footprint.
    let dbSecurityGroup: SecurityGroup | undefined;
    if (databaseRequired) {
      dbSecurityGroup = new SecurityGroup(this, 'DbSecurityGroup', {
        vpc: this.vpc as unknown as IVpc,
        description: 'RDS PostgreSQL access for the customer application',
      });
      // Allow the application (both Fargate and Express tasks) to reach RDS.
      // In Express mode the task security groups are ECS-managed, so the ingress
      // is opened to the whole VPC CIDR (private + public subnets) rather than a
      // single service security group we cannot reference.
      dbSecurityGroup.addIngressRule(
        Peer.ipv4(this.vpc.vpcCidrBlock),
        Port.tcp(DB_PORT),
        'Allow the application to reach RDS PostgreSQL',
      );

      this.database = new DatabaseInstance(this, 'Database', {
        engine: DatabaseInstanceEngine.postgres({
          version: PostgresEngineVersion.VER_16,
        }),
        instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
        vpc: this.vpc as unknown as IVpc,
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [dbSecurityGroup],
        credentials: Credentials.fromSecret(this.databaseSecret as unknown as ISecret, DB_USER),
        databaseName: DB_NAME,
        allocatedStorage: 20,
        maxAllocatedStorage: 100,
        storageEncrypted: true,
        backupRetention: Duration.days(7),
        preferredBackupWindow: '03:00-05:00',
        deletionProtection: true,
        deleteAutomatedBackups: false,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    }

    // Complete PostgreSQL connection URL, assembled at deploy time from the
    // generated master credentials via a CloudFormation dynamic reference —
    // the password never appears in the template or task definition.
    if (databaseRequired && (props.databaseUrlEnvNames?.length ?? 0) > 0) {
      this.databaseUrlSecret = new Secret(this, 'DatabaseUrlSecret', {
        description:
          'Complete PostgreSQL connection URL for the customer application. ' +
          'Assembled at deploy time from the generated master credentials — ' +
          'the password never appears in the template or task definition.',
        secretStringValue: SecretValue.unsafePlainText(
          `postgresql://${DB_USER}:${this.databaseSecret!.secretValueFromJson('password').unsafeUnwrap()}@${this.database!.instanceEndpoint.hostname}:${DB_PORT}/${DB_NAME}?sslmode=require`,
        ),
      });
    }

    // ── ElastiCache Valkey cache (Redis MVP, spec §13-18) ─────────────────
    // Gated entirely on redisRequired: when false/unset, zero ElastiCache
    // resources are created and no REDIS_* env vars are injected below — the
    // template stays byte-identical to a stack without this feature.
    const redisRequired = props.redisRequired ?? false;
    let redisSecurityGroup: SecurityGroup | undefined;
    let redisSubnetGroup: CfnSubnetGroup | undefined;
    if (redisRequired) {
      redisSubnetGroup = new CfnSubnetGroup(this, 'RedisSubnetGroup', {
        description: 'Deployz-managed private subnet group for the ElastiCache Valkey cache',
        subnetIds: this.vpc
          .selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS })
          .subnetIds,
      });

      redisSecurityGroup = new SecurityGroup(this, 'RedisSecurityGroup', {
        vpc: this.vpc as unknown as IVpc,
        description: 'ElastiCache Valkey access for the customer application',
      });
      // Allow the application (both Fargate and Express tasks) to reach the
      // cache. In Express mode the task security groups are ECS-managed, so
      // the ingress is opened to the whole VPC CIDR (private + public
      // subnets) rather than a single service security group we cannot
      // reference — same broad-VPC pattern as dbSecurityGroup above.
      redisSecurityGroup.addIngressRule(
        Peer.ipv4(this.vpc.vpcCidrBlock),
        Port.tcp(REDIS_PORT),
        'Allow the application to reach the ElastiCache Valkey cache',
      );

      // CfnReplicationGroup, not CfnCacheCluster: ElastiCache's
      // CreateCacheCluster API rejects the Valkey engine outright ("This API
      // doesn't support Valkey engine. Please use CreateReplicationGroup API
      // for Valkey cluster creation." — observed on a live install).
      // numCacheClusters: 1 + automaticFailoverEnabled/multiAzEnabled: false
      // keeps the same single-node, no-failover MVP profile.
      this.cache = new CfnReplicationGroup(this, 'Cache', {
        replicationGroupDescription:
          'Deployz-managed single-node Valkey cache for the customer application',
        engine: REDIS_ENGINE,
        cacheNodeType: REDIS_NODE_TYPE,
        numCacheClusters: 1,
        automaticFailoverEnabled: false,
        multiAzEnabled: false,
        // MVP profile is no TLS (spec §13-18); the Valkey engine defaults
        // TransitEncryptionEnabled to true and CloudFormation requires it be
        // set explicitly for this engine, so this is spelled out rather than
        // left to a default that would silently turn TLS on.
        transitEncryptionEnabled: false,
        port: REDIS_PORT,
        securityGroupIds: [redisSecurityGroup.securityGroupId],
        cacheSubnetGroupName: redisSubnetGroup.ref,
        // No explicit replicationGroupId — CFN logical-ID naming is
        // deterministic per stack and avoids ElastiCache's cluster-name
        // length limits (spec §14), matching the RDS instance's unnamed
        // pattern above.
      });
      this.cache.addResourceDependency(redisSubnetGroup);
    }

    // Resolved REDIS_* env var name/value pairs to inject into every
    // container (app + worker, both expressMode branches). Empty when
    // redisRequired is false — no REDIS_* env vars anywhere in that case.
    const cache = this.cache;
    const redisEnvEntries: Array<[string, string]> =
      redisRequired && cache !== undefined
        ? resolveRedisEnvBindings(props.redisEnvVars ?? []).map(
            (binding): [string, string] => {
              switch (binding.kind) {
                case 'url':
                  return [
                    binding.name,
                    `redis://${cache.attrPrimaryEndPointAddress}:${REDIS_PORT}`,
                  ];
                case 'host':
                  return [binding.name, cache.attrPrimaryEndPointAddress];
                case 'port':
                  return [binding.name, String(REDIS_PORT)];
              }
            },
          )
        : [];

    // databaseUrlEnvNames ECS secrets: the whole DatabaseUrlSecret value
    // (no JSON key suffix) injected under each configured env name into
    // every container (app + worker, both expressMode branches). Empty
    // when databaseUrlEnvNames is unset — no extra secrets in that case.
    const databaseUrlEnvNames = props.databaseUrlEnvNames ?? [];
    const databaseUrlSecrets = Object.fromEntries(
      databaseUrlEnvNames.map((envName) => [
        envName,
        EcsSecret.fromSecretsManager(this.databaseUrlSecret as unknown as ISecret),
      ]),
    );
    const expressDatabaseUrlSecrets = databaseUrlEnvNames.map((envName) => ({
      name: envName,
      valueFrom: this.databaseUrlSecret!.secretArn,
    }));

    // secretParameters ECS secrets, resolved once and injected into every
    // container (app + worker, both expressMode branches) — same parity
    // pattern as redisEnvEntries above. Empty when secretParameters is
    // unset — no extra secrets anywhere in that case.
    const extraSecrets = Object.fromEntries(
      secretParams.map(({ spec }) => [
        spec.envName,
        EcsSecret.fromSecretsManager(this.appSecret as unknown as ISecret, spec.secretKey),
      ]),
    );
    const expressExtraSecrets = secretParams.map(({ spec }) => ({
      name: spec.envName,
      valueFrom: `${this.appSecret.secretArn}:${spec.secretKey}::`,
    }));

    // ── ECS cluster (shared by both modes) ────────────────────────────────
    this.cluster = new Cluster(this, 'Cluster', {
      vpc: this.vpc as unknown as IVpc,
    });

    // ── IAM roles (shared by both modes) ──────────────────────────────────
    // The /deployz/ path is a contract: the relay's deploy-time iam:PassRole
    // grant is scoped to role/deployz/* (bootstrap-stack.ts), so ECS task
    // roles outside that path make every DEPLOY_RELEASE die on PassRole —
    // verified live before the path was added here.
    const taskExecutionRole = new Role(this, 'TaskExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      path: '/deployz/',
      description:
        'Allows ECS to pull the application image, write task logs, and ' +
        'inject secrets from Secrets Manager at task start.',
    });
    taskExecutionRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AmazonECSTaskExecutionRolePolicy',
      ),
    );
    this.databaseSecret?.grantRead(taskExecutionRole);
    this.databaseUrlSecret?.grantRead(taskExecutionRole);
    this.appSecret.grantRead(taskExecutionRole);

    const taskRole = new Role(this, 'TaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      path: '/deployz/',
      description: 'Runtime role for the customer application container.',
    });
    this.storageBucket.grantReadWrite(taskRole);
    this.databaseSecret?.grantRead(taskRole);
    this.databaseUrlSecret?.grantRead(taskRole);
    this.appSecret.grantRead(taskRole);

    // ── 2/3. ECS + ALB (branch on expressMode) ────────────────────────────
    let publicEndpoint: string;
    if (expressMode) {
      // Express Mode — ECS manages ALB/target-group/security-group/auto-scaling.
      const infrastructureRole = new Role(this, 'ExpressInfrastructureRole', {
        assumedBy: new ServicePrincipal('ecs.amazonaws.com'),
        description:
          'Allows ECS Express to manage the load balancer, target groups, ' +
          'security groups and auto-scaling for the customer application.',
      });
      infrastructureRole.addToPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'elasticloadbalancing:CreateLoadBalancer',
            'elasticloadbalancing:CreateTargetGroup',
            'elasticloadbalancing:CreateListener',
            'elasticloadbalancing:CreateRule',
            'elasticloadbalancing:DescribeLoadBalancers',
            'elasticloadbalancing:DescribeTargetGroups',
            'elasticloadbalancing:DescribeListeners',
            'elasticloadbalancing:ModifyLoadBalancerAttributes',
            'elasticloadbalancing:ModifyTargetGroup',
            'ec2:CreateSecurityGroup',
            'ec2:DescribeSecurityGroups',
            'ec2:AuthorizeSecurityGroupIngress',
            'ec2:RevokeSecurityGroupIngress',
            'application-autoscaling:RegisterScalableTarget',
            'application-autoscaling:PutScalingPolicy',
            'logs:CreateLogGroup',
            'logs:PutRetentionPolicy',
            'ecs:DescribeServices',
          ],
          resources: ['*'],
        }),
      );

      this.expressService = new CfnExpressGatewayService(this, 'ExpressService', {
        cluster: this.cluster.clusterName,
        serviceName: 'deployz-app',
        infrastructureRoleArn: infrastructureRole.roleArn,
        executionRoleArn: taskExecutionRole.roleArn,
        taskRoleArn: taskRole.roleArn,
        cpu: '256',
        memory: '512',
        healthCheckPath,
        networkConfiguration: {
          subnets: this.vpc
            .selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS })
            .subnetIds,
        },
        primaryContainer: {
          image: imageReference,
          containerPort,
          environment: [
            { name: 'NODE_ENV', value: 'production' },
            { name: 'PORT', value: String(containerPort) },
            ...(databaseRequired
              ? [
                  { name: 'DATABASE_HOST', value: this.database!.instanceEndpoint.hostname },
                  { name: 'DATABASE_PORT', value: String(DB_PORT) },
                  { name: 'DATABASE_NAME', value: DB_NAME },
                  { name: 'DATABASE_USER', value: DB_USER },
                ]
              : []),
            { name: 'STORAGE_BUCKET', value: this.storageBucket.bucketName },
            ...redisEnvEntries.map(([name, value]) => ({ name, value })),
            ...containerEnvEntries.map(([name, value]) => ({ name, value })),
          ],
          secrets: [
            ...(databaseRequired
              ? [
                  {
                    name: 'DATABASE_PASSWORD',
                    valueFrom: `${this.databaseSecret!.secretArn}:password::`,
                  },
                ]
              : []),
            {
              name: 'APP_API_KEY',
              valueFrom: `${this.appSecret.secretArn}:apiKey::`,
            },
            {
              name: 'APP_SIGNING_SECRET',
              valueFrom: `${this.appSecret.secretArn}:signingSecret::`,
            },
            ...expressExtraSecrets,
            ...expressDatabaseUrlSecrets,
          ],
          awsLogsConfiguration: {
            logGroup: logGroup.logGroupName,
            logStreamPrefix: 'deployz-app',
          },
        },
        scalingTarget: {
          minTaskCount: desiredCount,
          maxTaskCount: 4,
        },
      });

      publicEndpoint = this.expressService.attrEndpoint;
    } else {
      // Plain Fargate — explicit task definition, service and ALB.
      const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
        memoryLimitMiB: props.taskMemoryMiB ?? 512,
        cpu: props.taskCpu ?? 256,
        // Without this, CDK auto-creates a second execution role and grants
        // it only what it can infer. `ContainerImage.fromRegistry` is an
        // opaque string, so CDK cannot tell the image lives in ECR and
        // grants no pull permissions at all — which is fine for a public
        // image and fatal for a vendor's own build. `taskExecutionRole`
        // carries AmazonECSTaskExecutionRolePolicy, and until now was
        // created and used only by the Express branch.
        executionRole: taskExecutionRole,
        taskRole,
        runtimePlatform: {
          operatingSystemFamily: OperatingSystemFamily.LINUX,
          cpuArchitecture: CpuArchitecture.X86_64,
        },
      });

const dbEnv =
          databaseRequired && this.database
            ? {
                DATABASE_HOST: this.database.instanceEndpoint.hostname,
                DATABASE_PORT: String(DB_PORT),
                DATABASE_NAME: DB_NAME,
                DATABASE_USER: DB_USER,
              }
            : {};
        const dbSecrets =
          databaseRequired && this.databaseSecret
            ? {
                DATABASE_PASSWORD: EcsSecret.fromSecretsManager(
                  this.databaseSecret as unknown as ISecret,
                  'password',
                ),
              }
            : {};
        taskDefinition.addContainer('App', {
          image: ContainerImage.fromRegistry(imageReference),
          portMappings: [{ containerPort, protocol: Protocol.TCP }],
          logging: LogDriver.awsLogs({ streamPrefix: 'deployz-app', logGroup }),
          environment: {
            NODE_ENV: 'production',
            PORT: String(containerPort),
            ...dbEnv,
            STORAGE_BUCKET: this.storageBucket.bucketName,
            ...Object.fromEntries(redisEnvEntries),
            ...Object.fromEntries(containerEnvEntries),
          },
          secrets: {
            ...dbSecrets,
            APP_API_KEY: EcsSecret.fromSecretsManager(
              this.appSecret as unknown as ISecret,
              'apiKey',
            ),
            APP_SIGNING_SECRET: EcsSecret.fromSecretsManager(
              this.appSecret as unknown as ISecret,
              'signingSecret',
            ),
            ...extraSecrets,
            ...databaseUrlSecrets,
          },
        healthCheck: {
          command: [
            'CMD-SHELL',
            props.healthCheckShellCommand ??
              `curl -f http://localhost:${containerPort}${healthCheckPath} || exit 1`,
          ],
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          retries: 3,
          startPeriod: Duration.seconds(props.startupGracePeriodSeconds ?? 60),
        },
      });

      this.fargateService = new FargateService(this, 'Service', {
        cluster: this.cluster as unknown as ICluster,
        taskDefinition,
        desiredCount,
        assignPublicIp: false,
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { enable: true, rollback: true },
        ...(props.startupGracePeriodSeconds !== undefined
          ? { healthCheckGracePeriod: Duration.seconds(props.startupGracePeriodSeconds) }
          : {}),
      });

      this.loadBalancer = new ApplicationLoadBalancer(this, 'LoadBalancer', {
        vpc: this.vpc as unknown as IVpc,
        internetFacing: true,
      });

      // Open 443 up front, whether or not a certificate exists at synth time.
      // A custom domain is attached AFTER install: the relay's CONFIGURE_DOMAIN
      // adds the HTTPS listener over the ELBv2 API, and that API cannot open
      // this security group. Without this rule the new listener is unreachable,
      // the HTTPS probe never succeeds, and the domain never leaves
      // CONFIGURING. An open port with no listener refuses connections, so
      // this grants no reachability the listener itself does not.
      this.loadBalancer.connections.allowFromAnyIpv4(
        Port.tcp(443),
        'HTTPS for a custom domain attached after install',
      );

      const certificateArn = props.certificateArn;
      let appTargets: ApplicationTargetGroup | undefined;
      if (certificateArn !== undefined) {
        const httpListener = this.loadBalancer.addListener('HttpListener', {
          port: 80,
        });
        httpListener.addAction('HttpRedirect', {
          action: ListenerAction.redirect({
            protocol: 'HTTPS',
            port: '443',
            permanent: true,
          }),
        });

        const httpsListener = this.loadBalancer.addListener('HttpsListener', {
          port: 443,
          protocol: ApplicationProtocol.HTTPS,
          certificates: [ListenerCertificate.fromArn(certificateArn)],
        });
        appTargets = httpsListener.addTargets('AppTargets', {
          port: containerPort,
          protocol: ApplicationProtocol.HTTP,
          healthCheck: { path: healthCheckPath },
          targets: [this.fargateService],
        });
      } else {
        const listener = this.loadBalancer.addListener('HttpListener', {
          port: 80,
        });
        appTargets = listener.addTargets('AppTargets', {
          port: containerPort,
          protocol: ApplicationProtocol.HTTP,
          healthCheck: { path: healthCheckPath },
          targets: [this.fargateService],
        });
      }

      // Baseline AWS-side alarm state for unhealthy targets. No notification
      // wiring — the MVP purpose is the alarm's own state in CloudWatch, not
      // end-user alerts.
      appTargets.metricUnhealthyHostCount({ period: Duration.seconds(60) }).createAlarm(
        this,
        'UnhealthyTargetAlarm',
        {
          threshold: 1,
          evaluationPeriods: 3,
          datapointsToAlarm: 3,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        },
      );

      publicEndpoint = this.loadBalancer.loadBalancerDnsName;

      // ── Background worker (plain Fargate only) ─────────────────────────
      if (props.workerCommand !== undefined) {
        const workerLogGroup = new LogGroup(this, 'WorkerLogGroup', {
          retention: RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        });
        this.workerLogGroup = workerLogGroup;

        const workerTaskDefinition = new FargateTaskDefinition(
          this,
          'WorkerTaskDefinition',
          {
            memoryLimitMiB: 512,
            cpu: 256,
            executionRole: taskExecutionRole,
            taskRole,
            runtimePlatform: {
              operatingSystemFamily: OperatingSystemFamily.LINUX,
              cpuArchitecture: CpuArchitecture.X86_64,
            },
          },
        );

        workerTaskDefinition.addContainer('Worker', {
          image: ContainerImage.fromRegistry(imageReference),
          command: props.workerCommand.split(' '),
          logging: LogDriver.awsLogs({
            streamPrefix: 'deployz-worker',
            logGroup: workerLogGroup,
          }),
          environment: {
            NODE_ENV: 'production',
            ...dbEnv,
            STORAGE_BUCKET: this.storageBucket.bucketName,
            ...Object.fromEntries(redisEnvEntries),
            ...Object.fromEntries(containerEnvEntries),
          },
          secrets: {
            ...dbSecrets,
            APP_API_KEY: EcsSecret.fromSecretsManager(
              this.appSecret as unknown as ISecret,
              'apiKey',
            ),
            APP_SIGNING_SECRET: EcsSecret.fromSecretsManager(
              this.appSecret as unknown as ISecret,
              'signingSecret',
            ),
            ...extraSecrets,
            ...databaseUrlSecrets,
          },
        });

        this.workerService = new FargateService(this, 'WorkerService', {
          cluster: this.cluster as unknown as ICluster,
          taskDefinition: workerTaskDefinition,
          desiredCount: 1,
          assignPublicIp: false,
          vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
          minHealthyPercent: 100,
          maxHealthyPercent: 200,
          circuitBreaker: { enable: true, rollback: true },
        });
      }
    }

    // ── deployz: tags (§15) ───────────────────────────────────────────────
    // deployz:component is static — applied to every taggable resource.
    // deployz:application / deployz:vendor / deployz:installation are all
    // applied the same way, in-construct, from the corresponding optional
    // props — §15 requires all three for predictable resource identification.
    Tags.of(this).add('deployz:component', 'application');

    if (props.applicationId !== undefined) {
      for (const c of [
        this,
        this.vpc,
        this.database,
        this.databaseSecret,
        this.databaseUrlSecret,
        this.appSecret,
        this.storageBucket,
        this.cluster,
        logGroup,
        dbSecurityGroup,
        taskExecutionRole,
        taskRole,
        this.loadBalancer,
        this.fargateService,
        this.expressService,
        this.workerService,
        this.workerLogGroup,
        redisSubnetGroup,
        redisSecurityGroup,
        this.cache,
      ]) {
        if (c !== undefined) {
          Tags.of(c).add('deployz:application', props.applicationId);
        }
      }
    }

    if (props.vendorId !== undefined) {
      for (const c of [
        this,
        this.vpc,
        this.database,
        this.databaseSecret,
        this.databaseUrlSecret,
        this.appSecret,
        this.storageBucket,
        this.cluster,
        logGroup,
        dbSecurityGroup,
        taskExecutionRole,
        taskRole,
        this.loadBalancer,
        this.fargateService,
        this.expressService,
        this.workerService,
        this.workerLogGroup,
        redisSubnetGroup,
        redisSecurityGroup,
        this.cache,
      ]) {
        if (c !== undefined) {
          Tags.of(c).add('deployz:vendor', props.vendorId);
        }
      }
    }

    if (props.installationId !== undefined) {
      for (const c of [
        this,
        this.vpc,
        this.database,
        this.databaseSecret,
        this.databaseUrlSecret,
        this.appSecret,
        this.storageBucket,
        this.cluster,
        logGroup,
        dbSecurityGroup,
        taskExecutionRole,
        taskRole,
        this.loadBalancer,
        this.fargateService,
        this.expressService,
        this.workerService,
        this.workerLogGroup,
        redisSubnetGroup,
        redisSecurityGroup,
        this.cache,
      ]) {
        if (c !== undefined) {
          Tags.of(c).add('deployz:installation', props.installationId);
        }
      }
    }

    // ── Stack outputs ─────────────────────────────────────────────────────
    if (this.database !== undefined) {
      this.exportValue(this.database.instanceEndpoint.hostname, {
        name: `${this.stackName}-DbHost`,
      });
    }
    if (this.databaseSecret !== undefined) {
      this.exportValue(this.databaseSecret.secretArn, {
        name: `${this.stackName}-DbSecretArn`,
      });
    }
    this.exportValue(this.storageBucket.bucketName, {
      name: `${this.stackName}-StorageBucketName`,
    });
    this.exportValue(this.cluster.clusterName, {
      name: `${this.stackName}-ClusterName`,
    });
    this.exportValue(publicEndpoint, {
      name: `${this.stackName}-PublicEndpoint`,
    });
    if (this.cache !== undefined) {
      this.exportValue(this.cache.attrPrimaryEndPointAddress, {
        name: `${this.stackName}-CacheEndpoint`,
      });
    }
  }
}

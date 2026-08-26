/**
 * Bootstrap stack — the first CloudFormation template a Deployz customer
 * deploys into their OWN AWS account via the one-click Quick Create link.
 *
 * This is DISTINCT from the control-plane stack (DeployzStack, todo 7). It
 * runs in the customer account and establishes the egress-only trust channel:
 *
 *   1. Installation identifier  — a UUIDv4 minted at deploy time by a Custom
 *      Resource (never a template parameter, never in the Quick Create URL).
 *   2. Communication credential — a bootstrap-generated secret
 *      (`AWS::SecretsManager::Secret` + `GenerateSecretString`); CloudFormation
 *      mints it at deploy time, so it is never a template parameter and never
 *      carried in the Quick Create URL. The control plane binds install ID ↔
 *      token on the relay's FIRST poll.
 *   3. Relay Lambda + EventBridge schedule — the outbound actor that polls the
 *      control plane on a fixed schedule (egress-only: the control plane never
 *      reaches INTO the customer account).
 *   4. Execution role — least privilege + a permissions boundary, with a
 *      two-phase permission design:
 *        - Phase 1 (install-time): minimal — write relay logs + read/write the
 *          bootstrap-generated credential secret.
 *        - Phase 2 (post-first-contact): provisioner permissions to apply the
 *          versioned application stack, ALL constrained by the `deployz:`
 *          tag boundary. Not attached at install; the control plane attaches
 *          it after the relay registers.
 *   5. `deployz:` tags on every taggable resource (§15).
 *   6. IAM data-boundary denial: the relay role has NO `logs:GetLogEvents` /
 *      `logs:FilterLogEvents` (§16 — it writes logs, never reads them back).
 */
import {
  CfnParameter,
  CustomResource,
  Duration,
  Stack,
  Tags,
  type StackProps,
} from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface BootstrapStackProps extends StackProps {
  /**
   * Base URL of the Deployz control plane that the relay polls.
   *
   * This is a NON-secret, public URL. It is intentionally a template parameter
   * (so the Quick Create URL can point the relay at the right control plane),
   * but it is never a credential. Defaults to the production control plane.
   */
  readonly controlPlaneUrl?: string;
  /**
   * Single-use enrollment code minted by the control plane and carried in the
   * install link. Not a standing credential: it is spent on the relay's first
   * contact and is worthless afterwards.
   */
  readonly enrollmentCode?: string;
  /** Deployz application identifier — applied as `deployz:application` tag. */
  readonly applicationId?: string;
  /** Deployz vendor identifier — applied as `deployz:vendor` tag. */
  readonly vendorId?: string;
}

const DEFAULT_CONTROL_PLANE_URL = 'https://api.deployz.dev';

/** Install-time (phase 1) + post-first-contact (phase 2) permission actions. */
const PHASE_1_LOG_WRITE_ACTIONS = [
  'logs:CreateLogGroup',
  'logs:CreateLogStream',
  'logs:PutLogEvents',
] as const;

const PHASE_1_SECRET_ACTIONS = [
  'secretsmanager:GetSecretValue',
  'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret',
  'secretsmanager:DescribeSecret',
] as const;

/** Phase 2 — CloudFormation stack create/update within the tag boundary. */
const PHASE_2_CREATE_STACK_ACTIONS = [
  'cloudformation:CreateStack',
  'cloudformation:UpdateStack',
  'cloudformation:CreateChangeSet',
  'cloudformation:ExecuteChangeSet',
] as const;

/** Phase 2 — CloudFormation stack manage (read/delete) within the tag boundary. */
const PHASE_2_MANAGE_STACK_ACTIONS = [
  'cloudformation:DeleteStack',
  'cloudformation:DeleteChangeSet',
  'cloudformation:DescribeStacks',
  'cloudformation:DescribeStackEvents',
  'cloudformation:DescribeStackResources',
] as const;

/**
 * Phase 2 — application-stack resource lifecycle within the tag boundary.
 * The application stack's OWN service role (todo 9) carries the bulk of the
 * resource provisioning; this set lets the relay reconcile desired-vs-observed
 * state on the resources it manages.
 */
const PHASE_2_APP_RESOURCE_ACTIONS = [
  'ecs:UpdateService',
  'ecs:DeleteService',
  'ecs:DescribeServices',
  'rds:ModifyDBInstance',
  'rds:DeleteDBInstance',
  'rds:DescribeDBInstances',
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetHealth',
] as const;

/** Phase 2 — custom-domain certificate lifecycle (custom-domains MVP). */
const PHASE_2_ACM_REQUEST_ACTIONS = ['acm:RequestCertificate', 'acm:AddTagsToCertificate'] as const;
const PHASE_2_ACM_MANAGE_ACTIONS = [
  'acm:DescribeCertificate',
  'acm:DeleteCertificate',
  'acm:ListTagsForCertificate',
] as const;
/** Phase 2 — custom-domain HTTPS listener management on the deployment's ALB. */
const PHASE_2_DOMAIN_INGRESS_ACTIONS = [
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeListenerCertificates',
  'elasticloadbalancing:DescribeTags',
  'elasticloadbalancing:DescribeRules',
  'elasticloadbalancing:CreateListener',
  'elasticloadbalancing:ModifyListener',
  'elasticloadbalancing:DeleteListener',
  'elasticloadbalancing:AddListenerCertificates',
  'elasticloadbalancing:RemoveListenerCertificates',
] as const;

/** Phase 2 — provision and reconcile the application's ElastiCache Valkey cache (Redis MVP). */
const PHASE_2_CACHE_ACTIONS = [
  'elasticache:CreateCacheCluster',
  'elasticache:DeleteCacheCluster',
  'elasticache:DescribeCacheClusters',
  'elasticache:ModifyCacheCluster',
  'elasticache:CreateCacheSubnetGroup',
  'elasticache:DeleteCacheSubnetGroup',
  'elasticache:DescribeCacheSubnetGroups',
  'elasticache:AddTagsToResource',
  'elasticache:ListTagsForResource',
] as const;

export class BootstrapStack extends Stack {
  public readonly relayFunction: NodejsFunction;
  public readonly relayRole: Role;
  public readonly credentialSecret: Secret;
  public readonly permissionsBoundary: ManagedPolicy;
  public readonly provisionerPolicy: ManagedPolicy;
  /** Deploy-time token resolving to the minted installation UUID. */
  public readonly installationId: string;

  constructor(scope: Construct, id: string, props: BootstrapStackProps = {}) {
    super(scope, id, props);

    // ── Control-plane URL (non-secret parameter) ────────────────────────
    const controlPlaneUrlParam = new CfnParameter(this, 'ControlPlaneUrl', {
      type: 'String',
      description:
        'Base URL of the Deployz control plane the relay polls. NOT a credential.',
      default: props.controlPlaneUrl ?? DEFAULT_CONTROL_PLANE_URL,
    });

    // ── Enrollment code (single-use, non-secret parameter) ──────────────
    //
    // The one thing that ties this stack to a deployment in the control
    // plane. The installation identifier below is minted HERE, inside the
    // customer's account, so the control plane has never seen it and cannot
    // look anything up by it — without this code the relay's first call
    // would 404 and the deployment would never leave "Not installed".
    //
    // Single use: the control plane burns it when it binds this relay's id
    // and token, and refuses any later attempt to bind the same code to a
    // different relay. That is what stops whoever holds the install link
    // from registering a token of their own and taking the deployment over.
    const enrollmentCodeParam = new CfnParameter(this, 'EnrollmentCode', {
      type: 'String',
      description:
        'Single-use code from your install link. Ties this installation to your deployment.',
      default: props.enrollmentCode ?? '',
    });

    // ── 1. Installation identifier (minted at deploy time) ──────────────
    const installIdFunction = new NodejsFunction(this, 'InstallIdFunction', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(import.meta.dirname, '..', '..', 'src', 'lambda', 'bootstrap-init.ts'),
      handler: 'handler',
      timeout: Duration.minutes(1),
      memorySize: 128,
      bundling: {
        format: 'esm' as OutputFormat,
        target: 'node22',
        sourceMap: false,
      },
    });

    const installIdProvider = new Provider(this, 'InstallIdProvider', {
      onEventHandler: installIdFunction,
    });

    const installIdResource = new CustomResource(this, 'InstallationId', {
      serviceToken: installIdProvider.serviceToken,
    });

    this.installationId = installIdResource.getAttString('InstallationId');

    // ── 2. Communication credential (bootstrap-generated) ───────────────
    // GenerateSecretString mints a random 64-char token at deploy time. It is
    // NOT a template parameter and NOT in the Quick Create URL. The relay
    // reads it on first poll and registers it with the control plane.
    this.credentialSecret = new Secret(this, 'RelayCredential', {
      description:
        'Bootstrap-generated relay communication credential. Minted by ' +
        'CloudFormation at deploy time; registered with the control plane on ' +
        'the relay first poll. Never a template parameter.',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'token',
        passwordLength: 64,
        excludePunctuation: false,
      },
    });

    // ── 3. Execution role — least privilege + permissions boundary ──────
    const phase1LogWrite = new PolicyStatement({
      sid: 'RelayWriteLogs',
      effect: Effect.ALLOW,
      actions: [...PHASE_1_LOG_WRITE_ACTIONS],
      resources: ['*'],
    });

    const phase1SecretAccess = new PolicyStatement({
      sid: 'RelayAccessCredential',
      effect: Effect.ALLOW,
      actions: [...PHASE_1_SECRET_ACTIONS],
      resources: [this.credentialSecret.secretArn],
    });

    // Phase 2 — provisioner permissions, all constrained by the deployz: tag
    // boundary. Create/update requires the deployz:installation request tag;
    // manage/delete requires the resource already carries it.
    const phase2CreateStacks = new PolicyStatement({
      sid: 'ProvisionerCreateStacks',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_CREATE_STACK_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
      },
    });

    const phase2ManageStacks = new PolicyStatement({
      sid: 'ProvisionerManageStacks',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_MANAGE_STACK_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    const phase2PassRole = new PolicyStatement({
      sid: 'ProvisionerPassRole',
      effect: Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: ['arn:aws:iam::*:role/deployz/*'],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'cloudformation.amazonaws.com',
        },
      },
    });

    const phase2AppResources = new PolicyStatement({
      sid: 'ProvisionerAppResourceManage',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_APP_RESOURCE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Phase 2 — custom-domain certificate lifecycle (custom-domains MVP).
    // Request/tag requires the request tag (same pattern as stack create);
    // ACM has no way to scope RequestCertificate to a resource ARN, since the
    // certificate doesn't exist yet.
    const phase2AcmRequest = new PolicyStatement({
      sid: 'ProvisionerAcmRequest',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_ACM_REQUEST_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
      },
    });

    // Describe/delete/list-tags requires the certificate already carries the
    // installation's resource tag (same pattern as stack manage/delete).
    const phase2AcmManage = new PolicyStatement({
      sid: 'ProvisionerAcmManage',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_ACM_MANAGE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Phase 2 — custom-domain HTTPS listener management on the deployment's
    // ALB. The Describe* actions do not support resource-level restrictions,
    // so they stay condition-free (read-only); the listener-write actions are
    // scoped to the ALB/listener resources carrying the installation's tag.
    const domainIngressReadActions = PHASE_2_DOMAIN_INGRESS_ACTIONS.filter((action) =>
      action.startsWith('elasticloadbalancing:Describe'),
    );
    const domainIngressWriteActions = PHASE_2_DOMAIN_INGRESS_ACTIONS.filter(
      (action) => !action.startsWith('elasticloadbalancing:Describe'),
    );

    const phase2DomainIngressDescribe = new PolicyStatement({
      sid: 'ProvisionerDomainIngressDescribe',
      effect: Effect.ALLOW,
      actions: domainIngressReadActions,
      resources: ['*'],
    });

    const phase2DomainIngressWrite = new PolicyStatement({
      sid: 'ProvisionerDomainIngressWrite',
      effect: Effect.ALLOW,
      actions: domainIngressWriteActions,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Phase 2 — ElastiCache Valkey cache lifecycle (Redis MVP). Split the same
    // way as the ACM + domain-ingress precedent above:
    //   - Create* actions provision a brand-new resource that doesn't exist
    //     yet, so (like acm:RequestCertificate) they can only be scoped by the
    //     REQUEST tag applied at creation time, not a resource tag.
    //   - Delete/Modify/tag-management actions operate on a resource that
    //     already carries the installation's tag, so they are scoped by the
    //     RESOURCE tag (like ACM manage / stack manage).
    //   - Describe* actions do NOT support resource-level permissions in
    //     ElastiCache (same limitation as the ELB Describe* calls above), so
    //     they stay condition-free rather than carrying a condition that
    //     would never actually be evaluated.
    const cacheCreateActions = PHASE_2_CACHE_ACTIONS.filter((action) =>
      action.startsWith('elasticache:Create'),
    );
    const cacheDescribeActions = PHASE_2_CACHE_ACTIONS.filter((action) =>
      action.startsWith('elasticache:Describe'),
    );
    const cacheManageActions = PHASE_2_CACHE_ACTIONS.filter(
      (action) => !cacheCreateActions.includes(action) && !cacheDescribeActions.includes(action),
    );

    const phase2CacheCreate = new PolicyStatement({
      sid: 'ProvisionerCacheCreate',
      effect: Effect.ALLOW,
      actions: cacheCreateActions,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
      },
    });

    const phase2CacheManage = new PolicyStatement({
      sid: 'ProvisionerCacheManage',
      effect: Effect.ALLOW,
      actions: cacheManageActions,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    const phase2CacheDescribe = new PolicyStatement({
      sid: 'ProvisionerCacheDescribe',
      effect: Effect.ALLOW,
      actions: cacheDescribeActions,
      resources: ['*'],
    });

    const phase2Statements = [
      phase2CreateStacks,
      phase2ManageStacks,
      phase2PassRole,
      phase2AppResources,
      phase2AcmRequest,
      phase2AcmManage,
      phase2DomainIngressDescribe,
      phase2DomainIngressWrite,
      phase2CacheCreate,
      phase2CacheManage,
      phase2CacheDescribe,
    ];

    // The permissions boundary is the CEILING for the relay role: the union of
    // phase 1 + phase 2. The role can never exceed it, even after the control
    // plane attaches the provisioner policy post-first-contact.
    this.permissionsBoundary = new ManagedPolicy(this, 'PermissionsBoundary', {
      description:
        'Maximum permissions for the Deployz relay execution role (union of ' +
        'phase 1 + phase 2). All within the deployz: tag boundary.',
      statements: [
        phase1LogWrite,
        phase1SecretAccess,
        ...phase2Statements,
      ],
    });

    // Phase 2 provisioner policy — DEFINED but NOT attached at install time.
    // The control plane attaches it to the relay role after the relay's first
    // contact (the two-phase mechanic). Exported so the control plane can find it.
    this.provisionerPolicy = new ManagedPolicy(this, 'ProvisionerPolicy', {
      description:
        'Post-first-contact provisioner permissions for the relay (phase 2). ' +
        'All within the deployz: tag boundary. Attached by the control plane.',
      statements: phase2Statements,
    });

    this.relayRole = new Role(this, 'RelayRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role for the Deployz relay Lambda. Least privilege ' +
        '(phase 1) with a permissions boundary; phase 2 provisioner policy is ' +
        'attached by the control plane after first contact.',
      permissionsBoundary: this.permissionsBoundary,
    });
    this.relayRole.addToPolicy(phase1LogWrite);
    this.relayRole.addToPolicy(phase1SecretAccess);

    // ── 4. Relay Lambda + EventBridge schedule ──────────────────────────
    this.relayFunction = new NodejsFunction(this, 'RelayFunction', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(import.meta.dirname, '..', '..', 'src', 'lambda', 'relay-handler.ts'),
      handler: 'handler',
      role: this.relayRole,
      timeout: Duration.minutes(5),
      memorySize: 256,
      logRetention: RetentionDays.ONE_WEEK,
      environment: {
        DEPLOYZ_INSTALLATION_ID: this.installationId,
        DEPLOYZ_CREDENTIAL_SECRET_ARN: this.credentialSecret.secretArn,
        DEPLOYZ_CONTROL_PLANE_URL: controlPlaneUrlParam.valueAsString,
        DEPLOYZ_ENROLLMENT_CODE: enrollmentCodeParam.valueAsString,
      },
      bundling: {
        format: 'esm' as OutputFormat,
        target: 'node22',
        sourceMap: true,
      },
    });

    const relaySchedule = new Rule(this, 'RelaySchedule', {
      description: 'Polls the Deployz control plane every 5 minutes (egress-only).',
      schedule: Schedule.rate(Duration.minutes(5)),
      targets: [new LambdaFunction(this.relayFunction)],
    });

    // ── 5. deployz: tags (§15) ──────────────────────────────────────────
    // deployz:component is a static value — applied to EVERY taggable
    // resource, including the install-id custom-resource Lambda/role that
    // mint the identifier.
    Tags.of(this).add('deployz:component', 'bootstrap');

    // deployz:installation is a deploy-time token (Fn::GetAtt on the minted
    // id). It is applied to the DOWNSTREAM resources that consume the id. The
    // install-id generator itself cannot self-tag with its own output (that
    // would be a cyclic dependency), so those few resources carry only
    // deployz:component.
    for (const target of [
      this.relayRole,
      this.relayFunction,
      this.credentialSecret,
      relaySchedule,
    ]) {
      Tags.of(target).add('deployz:installation', this.installationId);
    }

    if (props.applicationId !== undefined) {
      for (const c of [
        this,
        this.relayRole,
        this.relayFunction,
        this.credentialSecret,
        relaySchedule,
        installIdFunction,
        installIdProvider,
        installIdResource,
      ]) {
        Tags.of(c).add('deployz:application', props.applicationId);
      }
    }

    if (props.vendorId !== undefined) {
      for (const c of [
        this,
        this.relayRole,
        this.relayFunction,
        this.credentialSecret,
        relaySchedule,
        installIdFunction,
        installIdProvider,
        installIdResource,
      ]) {
        Tags.of(c).add('deployz:vendor', props.vendorId);
      }
    }

    // AWS::IAM::ManagedPolicy has no `Tags` property in CloudFormation, so the
    // permissions-boundary and provisioner policies cannot carry deployz:
    // tags. They remain bound to the installation by the deployz:installation
    // IAM condition in their statements and the ARN exports below.

    // ── 6. Stack outputs (control-plane handshake surface) ──────────────
    this.exportValue(this.relayFunction.functionArn, {
      name: `${this.stackName}-RelayFunctionArn`,
    });
    this.exportValue(this.credentialSecret.secretArn, {
      name: `${this.stackName}-CredentialSecretArn`,
    });
    this.exportValue(this.provisionerPolicy.managedPolicyArn, {
      name: `${this.stackName}-ProvisionerPolicyArn`,
    });
    this.exportValue(this.installationId, {
      name: `${this.stackName}-InstallationId`,
    });
  }
}

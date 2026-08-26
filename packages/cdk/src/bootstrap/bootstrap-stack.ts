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
  Policy,
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
  /**
   * Public URL of the published application template the relay installs.
   *
   * Non-secret, and a template parameter for the same reason
   * `controlPlaneUrl` is: the publisher bakes the current default in, and a
   * specific installation can be pointed elsewhere without new relay code.
   */
  readonly applicationTemplateUrl?: string;
}

const DEFAULT_CONTROL_PLANE_URL = 'https://api.deployz.dev';

/**
 * Empty by default, and deliberately so: a URL guessed here would be one
 * CloudFormation cannot fetch, and the install would fail inside the
 * customer's account with nothing they can act on. The publisher fills this
 * in (see `scripts/publish-bootstrap.mjs`), and the INSTALL executor
 * refuses to run without it.
 */
const DEFAULT_APPLICATION_TEMPLATE_URL = '';

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
 * Phase 2 — read-only stack access so the relay can verify its own
 * installation. Both actions are already inside
 * `PHASE_2_MANAGE_STACK_ACTIONS`, so this grant does not raise the
 * permissions boundary's ceiling — it only extends what the role is
 * actually granted beneath it.
 */
const PHASE_2_VERIFY_STACK_ACTIONS = [
  'cloudformation:DescribeStacks',
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

/**
 * Phase 2 — the relay's own durable note of a command it has not finished.
 *
 * An application stack takes longer to create than a Lambda invocation may
 * run, and the control plane never re-offers a job once it has handed it
 * out. The relay therefore records which command it still owes an answer to
 * and picks it back up on a later poll. Scoped by parameter ARN — the name
 * carries the installation id — rather than by tag, because a parameter
 * being written for the first time has no tags to match on.
 */
const PHASE_2_RELAY_STATE_ACTIONS = [
  'ssm:GetParameter',
  'ssm:PutParameter',
  'ssm:DeleteParameter',
] as const;

// ── Application-stack provisioning (the CloudFormation execution role) ──────
//
// Creates: conditioned on the installation REQUEST tag. CloudFormation
// propagates the stack-level `Tags` the relay passes on `CreateStack` onto
// every resource that supports tag-on-create, so these conditions are
// satisfied by the same tag the verifier later reads back off the stack.
const PROVISION_CREATE_ACTIONS = [
  'ec2:CreateVpc',
  'ec2:CreateSubnet',
  'ec2:CreateRouteTable',
  'ec2:CreateInternetGateway',
  'ec2:CreateNatGateway',
  'ec2:AllocateAddress',
  'ec2:CreateSecurityGroup',
  'ec2:CreateTags',
  'ecs:CreateCluster',
  'ecs:CreateService',
  'ecs:RegisterTaskDefinition',
  'ecs:TagResource',
  'rds:CreateDBSubnetGroup',
  'rds:CreateDBInstance',
  'rds:AddTagsToResource',
  'elasticloadbalancing:CreateLoadBalancer',
  'elasticloadbalancing:CreateTargetGroup',
  'elasticloadbalancing:CreateListener',
  'elasticloadbalancing:AddTags',
  'secretsmanager:CreateSecret',
  'secretsmanager:TagResource',
  'logs:CreateLogGroup',
  'logs:TagResource',
  'elasticache:CreateCacheSubnetGroup',
  'elasticache:CreateCacheCluster',
  'elasticache:AddTagsToResource',
  'iam:CreateRole',
  'iam:TagRole',
] as const;

// Modifies and deletes: conditioned on the installation RESOURCE tag. By the
// time any of these runs, the resource already carries the tag the matching
// create applied.
const PROVISION_MANAGE_ACTIONS = [
  'ec2:CreateRoute',
  'ec2:DeleteRoute',
  'ec2:AssociateRouteTable',
  'ec2:DisassociateRouteTable',
  'ec2:AttachInternetGateway',
  'ec2:DetachInternetGateway',
  'ec2:ModifyVpcAttribute',
  'ec2:ModifySubnetAttribute',
  'ec2:AuthorizeSecurityGroupIngress',
  'ec2:AuthorizeSecurityGroupEgress',
  'ec2:RevokeSecurityGroupIngress',
  'ec2:RevokeSecurityGroupEgress',
  'ec2:DeleteVpc',
  'ec2:DeleteSubnet',
  'ec2:DeleteRouteTable',
  'ec2:DeleteInternetGateway',
  'ec2:DeleteNatGateway',
  'ec2:ReleaseAddress',
  'ec2:DeleteSecurityGroup',
  'ec2:DeleteTags',
  'ecs:DeleteCluster',
  'ecs:UpdateService',
  'ecs:DeleteService',
  'ecs:DeregisterTaskDefinition',
  'rds:ModifyDBInstance',
  'rds:DeleteDBInstance',
  'rds:DeleteDBSubnetGroup',
  'elasticloadbalancing:ModifyLoadBalancerAttributes',
  'elasticloadbalancing:ModifyTargetGroup',
  'elasticloadbalancing:ModifyTargetGroupAttributes',
  'elasticloadbalancing:ModifyListener',
  'elasticloadbalancing:DeleteLoadBalancer',
  'elasticloadbalancing:DeleteTargetGroup',
  'elasticloadbalancing:DeleteListener',
  'elasticloadbalancing:RegisterTargets',
  'elasticloadbalancing:DeregisterTargets',
  'secretsmanager:GetSecretValue',
  'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret',
  'secretsmanager:DeleteSecret',
  'secretsmanager:GetResourcePolicy',
  'secretsmanager:PutResourcePolicy',
  'logs:PutRetentionPolicy',
  'logs:DeleteLogGroup',
  'elasticache:ModifyCacheCluster',
  'elasticache:DeleteCacheCluster',
  'elasticache:DeleteCacheSubnetGroup',
  'iam:PutRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:AttachRolePolicy',
  'iam:DetachRolePolicy',
  'iam:DeleteRole',
  'iam:UntagRole',
] as const;

/**
 * Reads. None of these support resource-level permissions, so a tag
 * condition on them would never match and would deny the whole stack.
 */
const PROVISION_READ_ACTIONS = [
  'ec2:DescribeVpcs',
  'ec2:DescribeVpcAttribute',
  'ec2:DescribeSubnets',
  'ec2:DescribeRouteTables',
  'ec2:DescribeInternetGateways',
  'ec2:DescribeNatGateways',
  'ec2:DescribeAddresses',
  'ec2:DescribeSecurityGroups',
  'ec2:DescribeSecurityGroupRules',
  'ec2:DescribeAvailabilityZones',
  'ec2:DescribeAccountAttributes',
  'ec2:DescribeNetworkInterfaces',
  'ec2:DescribeTags',
  'ecs:DescribeClusters',
  'ecs:DescribeServices',
  'ecs:DescribeTaskDefinition',
  'ecs:ListTagsForResource',
  'rds:DescribeDBInstances',
  'rds:DescribeDBSubnetGroups',
  'rds:ListTagsForResource',
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeLoadBalancerAttributes',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetGroupAttributes',
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeTags',
  'elasticloadbalancing:DescribeTargetHealth',
  'secretsmanager:DescribeSecret',
  'secretsmanager:ListSecretVersionIds',
  'logs:DescribeLogGroups',
  'logs:ListTagsForResource',
  'elasticache:DescribeCacheClusters',
  'elasticache:DescribeCacheSubnetGroups',
  'elasticache:ListTagsForResource',
  'iam:GetRole',
  'iam:GetRolePolicy',
  'iam:ListRolePolicies',
  'iam:ListAttachedRolePolicies',
  'iam:ListRoleTags',
] as const;

/**
 * S3 bucket lifecycle. S3 supports neither condition: `CreateBucket` takes
 * no request tags (CloudFormation tags the bucket afterwards, with
 * `PutBucketTagging`), and bucket actions do not honour `aws:ResourceTag`.
 * Granted without a tag condition rather than with one that could never
 * match — the containment here is the role's trust policy, which admits
 * only CloudFormation acting for this account.
 */
const PROVISION_STORAGE_ACTIONS = [
  's3:CreateBucket',
  's3:DeleteBucket',
  's3:ListBucket',
  's3:GetBucketLocation',
  's3:GetBucketTagging',
  's3:PutBucketTagging',
  's3:GetBucketVersioning',
  's3:PutBucketVersioning',
  's3:GetEncryptionConfiguration',
  's3:PutEncryptionConfiguration',
  's3:GetBucketPublicAccessBlock',
  's3:PutBucketPublicAccessBlock',
  's3:GetBucketPolicy',
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:GetBucketAcl',
  's3:GetLifecycleConfiguration',
  's3:PutLifecycleConfiguration',
] as const;

/** The services the application stack needs service-linked roles for. */
const PROVISION_SERVICE_LINKED_ROLE_SERVICES = [
  'ecs.amazonaws.com',
  'elasticloadbalancing.amazonaws.com',
  'rds.amazonaws.com',
  'elasticache.amazonaws.com',
] as const;

/** The services the execution role may hand the application task roles to. */
const PROVISION_PASS_ROLE_SERVICES = ['ecs-tasks.amazonaws.com', 'ecs.amazonaws.com'] as const;

export class BootstrapStack extends Stack {
  public readonly relayFunction: NodejsFunction;
  public readonly relayRole: Role;
  public readonly credentialSecret: Secret;
  public readonly permissionsBoundary: ManagedPolicy;
  public readonly provisionerPolicy: ManagedPolicy;
  /** CloudFormation execution role for the application stack (`role/deployz/*`). */
  public readonly applicationExecutionRole: Role;
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

    // ── Application template URL (non-secret parameter) ─────────────────
    //
    // The relay's INSTALL executor calls `CreateStack` with this as
    // `TemplateURL`. It is a parameter rather than a constant so an
    // installation can be pinned to a specific published template version,
    // and so a customer can be moved onto a new one by updating this stack
    // rather than by shipping new relay code.
    const applicationTemplateUrlParam = new CfnParameter(this, 'ApplicationTemplateUrl', {
      type: 'String',
      description:
        'Public URL of the Deployz application template this installation provisions. NOT a credential.',
      default: props.applicationTemplateUrl ?? DEFAULT_APPLICATION_TEMPLATE_URL,
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

    const phase2VerifyStack = new PolicyStatement({
      sid: 'RelayVerifyInstallation',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_VERIFY_STACK_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
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
    //   - Delete/Modify actions operate on a resource that already carries
    //     the installation's tag, so they are scoped by the RESOURCE tag
    //     (like ACM manage / stack manage).
    //   - Describe* actions do NOT support resource-level permissions in
    //     ElastiCache (same limitation as the ELB Describe* calls above), so
    //     they stay condition-free rather than carrying a condition that
    //     would never actually be evaluated.
    //
    // elasticache:AddTagsToResource sits in the CREATE bucket, not manage,
    // even though its name suggests "manage" — same reasoning ACM applies to
    // acm:AddTagsToCertificate (see PHASE_2_ACM_REQUEST_ACTIONS above). A
    // ResourceTag condition can only match a tag the resource ALREADY
    // carries; it can never authorize the FIRST call that applies
    // deployz:installation to a brand-new, untagged cache — that would be
    // asking the resource to already have the tag the call is meant to add.
    // Two things make this safe: (1) the primary tagging path is tags-on-
    // create — Task 7's ApplicationStack sets `Tags` directly on
    // CfnCacheCluster/CfnSubnetGroup, so CloudFormation creates them already
    // tagged via the Create* calls (which the RequestTag condition does
    // cover); (2) any subsequent AddTagsToResource — e.g. CloudFormation
    // re-applying the full tag set on a stack update — resends
    // deployz:installation as part of the request, so it still satisfies a
    // RequestTag condition. ListTagsForResource stays in MANAGE: it only
    // reads tags off a resource that (by the time it's called) already
    // carries them, so ResourceTag is the correct — and satisfiable — check.
    const cacheDescribeActions = PHASE_2_CACHE_ACTIONS.filter((action) =>
      action.startsWith('elasticache:Describe'),
    );
    const cacheCreateActions = PHASE_2_CACHE_ACTIONS.filter(
      (action) =>
        action.startsWith('elasticache:Create') || action === 'elasticache:AddTagsToResource',
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

    // Phase 2 — the relay's durable note of an unfinished command. Scoped by
    // parameter ARN: the name embeds the installation id, so one relay can
    // never read or overwrite another installation's.
    const phase2RelayState = new PolicyStatement({
      sid: 'RelayPendingCommandState',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_RELAY_STATE_ACTIONS],
      resources: [
        Stack.of(this).formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: `deployz/${this.installationId}/*`,
        }),
      ],
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
        phase2RelayState,
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
    this.relayRole.addToPolicy(phase2VerifyStack);
    this.relayRole.addToPolicy(phase2RelayState);

    // The provisioner policy used to be created and attached to nothing, on
    // the theory that the control plane would attach it after the relay's
    // first contact. It cannot: §15 forbids Deployz from holding
    // credentials in the customer's account, so no principal exists that
    // could make that call — which left the relay unable to call
    // `cloudformation:CreateStack` at all. Attach it here. The permissions
    // boundary above, which is the union of phase 1 and phase 2 and which
    // the role can never exceed, is what actually caps the grant.
    this.relayRole.addManagedPolicy(this.provisionerPolicy);

    // ── 3b. CloudFormation execution role for the application stack ─────
    //
    // The relay asks CloudFormation to create the application stack;
    // CloudFormation builds it. Those are two different principals, and only
    // the first is the relay. Passing this role on `CreateStack` is what
    // keeps it that way: the relay itself has no `ec2:CreateVpc`, no
    // `rds:CreateDBInstance` and no `iam:CreateRole`, and should not — it may
    // only ask CloudFormation to apply a published template that does.
    //
    // The path is `/deployz/` because the provisioner policy's `iam:PassRole`
    // is scoped to `arn:aws:iam::*:role/deployz/*`. That grant has been here
    // from the start with nothing to point at.
    //
    // Three things bound the role:
    //
    //   1. Who may assume it — only `cloudformation.amazonaws.com`, and only
    //      on behalf of THIS account. Not the relay, not a user, and not
    //      CloudFormation acting for anyone else.
    //   2. The installation tag — creates require the REQUEST tag, modifies
    //      and deletes require the RESOURCE tag. Both are satisfied by the
    //      stack-level `Tags` the relay passes on `CreateStack`, which
    //      CloudFormation propagates onto every resource that supports
    //      tagging. That is the same tag `verifyInstallation` reads back, so
    //      a stack that provisions is a stack that verifies.
    //   3. No wildcards — every action is named. A bare `ec2:*` would make
    //      the tag conditions decorative, since it would carry actions that
    //      cannot be tag-conditioned at all.
    //
    // Reads, S3 bucket operations and `iam:CreateServiceLinkedRole` are the
    // three groups that genuinely cannot carry a tag condition; each is
    // granted without one, and scoped by whatever AWS does support, rather
    // than with a condition that could never match. See the action lists.
    this.applicationExecutionRole = new Role(this, 'ApplicationExecutionRole', {
      path: '/deployz/',
      assumedBy: new ServicePrincipal('cloudformation.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
      description:
        'CloudFormation execution role for the Deployz application stack. Assumable only by ' +
        'CloudFormation on behalf of this account; every grant is scoped to the deployz: tag ' +
        'boundary where AWS supports it.',
    });

    const provisionCreate = new PolicyStatement({
      sid: 'ProvisionApplicationCreate',
      effect: Effect.ALLOW,
      actions: [...PROVISION_CREATE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
      },
    });

    const provisionManage = new PolicyStatement({
      sid: 'ProvisionApplicationManage',
      effect: Effect.ALLOW,
      actions: [...PROVISION_MANAGE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    const provisionRead = new PolicyStatement({
      sid: 'ProvisionApplicationRead',
      effect: Effect.ALLOW,
      actions: [...PROVISION_READ_ACTIONS],
      resources: ['*'],
    });

    const provisionStorage = new PolicyStatement({
      sid: 'ProvisionApplicationStorage',
      effect: Effect.ALLOW,
      actions: [...PROVISION_STORAGE_ACTIONS],
      resources: ['*'],
    });

    // CloudFormation hands the application's task roles to ECS when it
    // creates the service. Restricted to the two services that legitimately
    // receive them, so the role cannot be used to escalate into an
    // unrelated service by passing a role to it.
    const provisionPassRole = new PolicyStatement({
      sid: 'ProvisionApplicationPassRole',
      effect: Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'iam:PassedToService': [...PROVISION_PASS_ROLE_SERVICES],
        },
      },
    });

    // A first ECS service, load balancer, RDS instance or cache cluster in
    // an account needs that service's service-linked role to exist. Named
    // services only — `iam:CreateServiceLinkedRole` on `*` would let the
    // role bootstrap a principal for any AWS service at all.
    const provisionServiceLinkedRoles = new PolicyStatement({
      sid: 'ProvisionApplicationServiceLinkedRoles',
      effect: Effect.ALLOW,
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'iam:AWSServiceName': [...PROVISION_SERVICE_LINKED_ROLE_SERVICES],
        },
      },
    });

    // Separate `Policy` constructs rather than one: an inline role policy is
    // capped at 10,240 characters, and this set comfortably exceeds that as
    // a single document.
    new Policy(this, 'ProvisionApplicationWrite', {
      statements: [provisionCreate, provisionManage],
      roles: [this.applicationExecutionRole],
    });
    new Policy(this, 'ProvisionApplicationSupport', {
      statements: [
        provisionRead,
        provisionStorage,
        provisionPassRole,
        provisionServiceLinkedRoles,
      ],
      roles: [this.applicationExecutionRole],
    });

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
        DEPLOYZ_APPLICATION_TEMPLATE_URL: applicationTemplateUrlParam.valueAsString,
        DEPLOYZ_APPLICATION_EXECUTION_ROLE_ARN: this.applicationExecutionRole.roleArn,
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
    this.exportValue(this.applicationExecutionRole.roleArn, {
      name: `${this.stackName}-ApplicationExecutionRoleArn`,
    });
  }
}

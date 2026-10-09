import { writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DeploymentPlan } from '@deployz/contracts';

import { CustomerInstallSections } from '../src/components/customer-install-sections';

export function buildSnapshotFixture(): { plan: DeploymentPlan; envVarInputs: ReadonlyArray<{
  key: string;
  required: boolean;
  secret: boolean;
  classification?: string;
  purpose?: string;
}> } {
  const PLAN: DeploymentPlan = {
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-2',
    components: [],
    awsResources: [
      { id: 'connector_lambda', name: 'Deployz connector (AWS Lambda)', purpose: 'Runs the Deployz connector — it checks in with Deployz and performs deployment work in your account', group: 'connector', componentKind: 'other', lifecycle: 'retain' },
      { id: 'connector_role', name: 'Connector IAM role', purpose: 'Limits the connector to the deployment actions described on this page', group: 'connector', componentKind: 'other', lifecycle: 'retain' },
      { id: 'connector_credential', name: 'Connector credential (Secrets Manager)', purpose: 'Stores the credential the connector uses to identify itself with Deployz', group: 'connector', componentKind: 'other', lifecycle: 'retain' },
      { id: 'connector_schedule', name: 'Connector schedule (EventBridge)', purpose: 'Wakes the connector so it can pick up deployment work', group: 'connector', componentKind: 'other', lifecycle: 'retain' },
      { id: 'vpc', name: 'Private network (VPC)', purpose: 'Isolates the application from other resources in your account', group: 'compute_networking', componentKind: 'network', lifecycle: 'delete' },
      { id: 'nat_gateway', name: 'NAT gateway', purpose: 'Lets the application reach the internet from the private network', group: 'compute_networking', componentKind: 'network', lifecycle: 'delete' },
      { id: 'ecs_cluster', name: 'ECS cluster', purpose: 'Groups the containers that run the application', group: 'compute_networking', componentKind: 'application', lifecycle: 'delete' },
      { id: 'ecs_service', name: 'ECS Fargate service', purpose: 'Runs the application container and restarts it if it stops', group: 'compute_networking', componentKind: 'application', lifecycle: 'delete' },
      { id: 'load_balancer', name: 'Application Load Balancer', purpose: 'Receives web traffic and sends it to the application', group: 'compute_networking', componentKind: 'endpoint', lifecycle: 'delete' },
      { id: 'database', name: 'RDS PostgreSQL database', purpose: 'Stores persistent application data', group: 'data', componentKind: 'database', lifecycle: 'retain' },
      { id: 'storage_bucket', name: 'S3 bucket', purpose: 'Stores uploaded files', group: 'data', componentKind: 'storage', lifecycle: 'retain' },
      { id: 'app_config_secret', name: 'Application configuration secret', purpose: 'Holds the application settings and secrets you provide', group: 'security_operations', componentKind: 'other', lifecycle: 'delete' },
      { id: 'database_secrets', name: 'Database credential secrets', purpose: 'Hold the database password and connection details', group: 'security_operations', componentKind: 'database', lifecycle: 'retain' },
      { id: 'iam_roles', name: 'IAM roles', purpose: 'Give the application only the permissions it needs', group: 'security_operations', componentKind: 'application', lifecycle: 'delete' },
      { id: 'security_groups', name: 'Security groups', purpose: 'Restrict network traffic between the components', group: 'security_operations', componentKind: 'network', lifecycle: 'delete' },
      { id: 'log_group', name: 'CloudWatch log group', purpose: 'Collects application logs', group: 'security_operations', componentKind: 'monitoring', lifecycle: 'delete' },
      { id: 'health_alarm', name: 'CloudWatch alarm', purpose: 'Alerts when the application stops responding', group: 'security_operations', componentKind: 'monitoring', lifecycle: 'delete' },
    ],
    footprint: {
      schemaVersion: 1,
      region: 'us-east-2',
      workloads: [
        { id: 'web', role: 'web', label: 'Web application', quantity: 1, compute: { provider: 'aws', service: 'ecs-fargate', cpuUnits: 256, memoryMiB: 512, sizeLabel: 'Small' }, lifecycle: { persistent: false } },
      ],
      resources: [
        { id: 'database', label: 'RDS PostgreSQL', service: 'rds-postgres', category: 'database', quantity: 1, lifecycle: { persistent: true, retainOnDelete: true }, configuration: { engine: 'postgres', engineVersion: '16', instanceType: 'db.t3.micro', storageGb: 20 } },
        { id: 'storage_bucket', label: 'S3 bucket', service: 's3', category: 'storage', quantity: 1, lifecycle: { persistent: true, retainOnDelete: true }, configuration: {} },
        { id: 'cache', label: 'ElastiCache Valkey', service: 'elasticache-valkey', category: 'cache', quantity: 1, lifecycle: { persistent: false, retainOnDelete: false }, configuration: { nodeType: 'cache.t4g.micro' } },
      ],
    },
    costEstimate: {
      currency: 'USD',
      monthlyMin: 38,
      monthlyMax: 56,
      complete: true,
      items: [
        { resourceId: 'web', label: 'Fargate', monthlyMin: 8, monthlyMax: 11, pricingStatus: 'estimated' },
        { resourceId: 'database', label: 'RDS', monthlyMin: 14, monthlyMax: 19, pricingStatus: 'estimated' },
        { resourceId: 'cache', label: 'ElastiCache', monthlyMin: 12, monthlyMax: 15, pricingStatus: 'estimated' },
        { resourceId: 'load_balancer', label: 'ALB', monthlyMin: 15, monthlyMax: 25, pricingStatus: 'estimated' },
        { resourceId: 'nat_gateway', label: 'NAT gateway', monthlyMin: 30, monthlyMax: 40, pricingStatus: 'estimated' },
        { resourceId: 'storage_bucket', label: 'S3', pricingStatus: 'usage_based' },
      ],
      usageDependent: ['S3 storage and requests', 'NAT data processed'],
    },
    requirementDrift: [],
  };
  const envVarInputs = [
    { key: 'DATABASE_URL', required: true, secret: false, classification: 'deployz_managed', purpose: 'Database connection URL' },
    { key: 'S3_BUCKET', required: true, secret: false, classification: 'deployz_managed', purpose: 'Storage bucket name' },
    { key: 'REDIS_URL', required: true, secret: false, classification: 'deployz_managed', purpose: 'Cache connection URL' },
    { key: 'JWT_SECRET', required: true, secret: true, classification: 'customer_required', purpose: 'Signing secret' },
    { key: 'SMTP_API_KEY', required: true, secret: true, classification: 'customer_required', purpose: 'Email service API key' },
  ];
  return { plan: PLAN, envVarInputs };
}

describe('customer install — after snapshot', () => {
  it('renders the canonical composition for the screenshot fixture', () => {
    const { plan, envVarInputs } = buildSnapshotFixture();
    const html = renderToString(
      <CustomerInstallSections
        plan={plan}
        securityHref="/install/abc/security"
        envVarInputs={envVarInputs}
      />,
    );
    const { window } = new JSDOM(html);
    const doc = window.document;

    const ids = [
      'connector_lambda',
      'connector_role',
      'connector_credential',
      'connector_schedule',
      'vpc',
      'nat_gateway',
      'ecs_cluster',
      'ecs_service',
      'load_balancer',
      'database',
      'storage_bucket',
      'app_config_secret',
      'database_secrets',
      'iam_roles',
      'security_groups',
      'log_group',
      'health_alarm',
    ];
    for (const id of ids) {
      expect(doc.querySelector(`[data-testid="aws-resource-row-${id}"]`)).not.toBeNull();
    }

    expect(doc.querySelectorAll('[data-testid="aws-resources-table"]')).toHaveLength(1);
    expect(html).toContain('Most resources are removed with the deployment');
    expect(html).toContain('Estimated total');
    expect(html).toContain('AWS bills your account directly');

    expect(doc.querySelectorAll('[data-testid="env-vars-table"]')).toHaveLength(1);
    expect(html).toContain('2 need your input');
    expect(html).toContain('3 configured');
    expect(html).not.toContain('hunter2');

    expect(html).toContain('Before you deploy');
    expect(html).toContain('Security &amp; permissions details');

    const headings = Array.from(doc.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
    expect(headings).not.toContain('When removed');
    expect(headings).not.toContain('On removal');

    // Persist the rendered HTML for visual review.
    const outPath = process.env['SNIPSHOT_OUT'];
    if (outPath) {
      writeFileSync(outPath, `<!doctype html><html><body style="font-family:system-ui;padding:24px;max-width:920px;margin:auto auto;">${html}</body></html>`);
    }
  });
});
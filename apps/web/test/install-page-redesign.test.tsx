// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The redesigned /install/:installLinkId page keeps the existing
// heading, the existing launch button and every detailed AWS resource the
// canonical `installPlanResourceGroups` table produces. These tests pin
// those invariants so the redesign cannot lose a row or invent a cost.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const mocks = vi.hoisted(() => ({
  fetchPublicInstallData: vi.fn(),
  fetchInstallData: vi.fn(),
  fetchInstallStatusServer: vi.fn(),
}));

vi.mock('../src/lib/public-install-data', () => ({
  fetchPublicInstallData: mocks.fetchPublicInstallData,
}));
vi.mock('../src/lib/install-data', () => ({
  fetchInstallData: mocks.fetchInstallData,
  launchInstall: vi.fn(),
}));
vi.mock('../src/lib/install-status', () => ({
  fetchInstallStatusServer: mocks.fetchInstallStatusServer,
}));

const InstallPage = (await import('../src/app/install/[installLinkId]/page')).default;

const LINK_ID = '11111111-1111-1111-1111-111111111111';
const QUICK_CREATE = 'https://console.aws.amazon.com/cloudformation/quickcreate';

function resolvedData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicationName: 'Acme App',
    publisherName: 'Acme Inc',
    customerName: 'Customer One',
    region: 'us-east-1',
    plan: {
      schemaVersion: 1,
      action: 'INSTALL',
      region: 'us-east-1',
      components: [
        { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
        { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
      ],
      awsResources: [
        {
          id: 'ecs_service',
          name: 'ECS Fargate service',
          purpose: 'Runs the application container and restarts it if it stops',
          group: 'compute_networking',
          componentKind: 'application',
          lifecycle: 'delete',
        },
        {
          id: 'load_balancer',
          name: 'Application Load Balancer',
          purpose: 'Receives web traffic and sends it to the application',
          group: 'compute_networking',
          componentKind: 'endpoint',
          lifecycle: 'delete',
        },
        {
          id: 'vpc',
          name: 'Private network (VPC)',
          purpose: 'Isolates the application from other resources in your account',
          group: 'compute_networking',
          componentKind: 'network',
          lifecycle: 'delete',
        },
        {
          id: 'nat_gateway',
          name: 'NAT gateway',
          purpose: 'Lets the application reach the internet from the private network',
          group: 'compute_networking',
          componentKind: 'network',
          lifecycle: 'delete',
        },
        {
          id: 'database',
          name: 'RDS PostgreSQL database',
          purpose: 'Stores persistent application data',
          group: 'data',
          componentKind: 'database',
          lifecycle: 'retain',
        },
        {
          id: 'storage_bucket',
          name: 'S3 bucket',
          purpose: 'Stores uploaded files',
          group: 'data',
          componentKind: 'storage',
          lifecycle: 'retain',
        },
        {
          id: 'iam_roles',
          name: 'IAM roles',
          purpose: 'Give the application only the permissions it needs',
          group: 'security_operations',
          componentKind: 'application',
          lifecycle: 'delete',
        },
        {
          id: 'security_groups',
          name: 'Security groups',
          purpose: 'Restrict network traffic between the components',
          group: 'security_operations',
          componentKind: 'network',
          lifecycle: 'delete',
        },
        {
          id: 'log_group',
          name: 'CloudWatch log group',
          purpose: 'Collects application logs',
          group: 'security_operations',
          componentKind: 'monitoring',
          lifecycle: 'delete',
        },
        {
          id: 'health_alarm',
          name: 'CloudWatch alarm',
          purpose: 'Alerts when the application stops responding',
          group: 'security_operations',
          componentKind: 'monitoring',
          lifecycle: 'delete',
        },
      ],
      footprint: {
        region: 'us-east-1',
        workloads: [
          {
            id: 'web',
            label: 'Web application',
            quantity: 1,
            compute: { service: 'ecs-fargate', sizeLabel: 'Small', cpuUnits: 256, memoryMiB: 512 },
            role: 'web',
          },
        ],
        resources: [
          {
            id: 'database',
            category: 'database',
            provider: 'aws',
            service: 'rds-postgres',
            role: 'database',
            label: 'PostgreSQL',
            quantity: 1,
            configuration: { engine: 'postgres', instanceType: 'db.t4g.micro', storageGb: 20 },
            lifecycle: { persistent: true, retainOnDelete: true },
          },
          {
            id: 'storage',
            category: 'storage',
            provider: 'aws',
            service: 's3',
            role: 'storage',
            label: 'S3',
            quantity: 1,
            configuration: {},
            lifecycle: { persistent: true, retainOnDelete: true },
          },
        ],
      },
      costEstimate: {
        currency: 'USD',
        monthlyMin: 50,
        monthlyMax: 80,
        complete: true,
        items: [
          {
            resourceId: 'web',
            label: 'Web application',
            monthlyMin: 9,
            monthlyMax: 11,
            pricingStatus: 'estimated',
          },
          {
            resourceId: 'database',
            label: 'PostgreSQL',
            monthlyMin: 14,
            monthlyMax: 19,
            pricingStatus: 'estimated',
          },
          {
            resourceId: 'storage',
            label: 'S3',
            pricingStatus: 'usage_based',
          },
        ],
        usageDependent: [],
      },
      requirementDrift: [],
    },
    quickCreateUrl: QUICK_CREATE,
    alreadyInstalled: false,
    deploymentId: 'dep-1',
    deploymentState: 'NOT_INSTALLED',
    domain: null,
    routingTarget: null,
    bootstrapStackName: 'deployz-bootstrap-acme-app-dep-1',
    waitingForRelay: false,
    relayStuck: false,
    components: null,
    releaseVersion: '1.2.0',
    ...overrides,
  };
}

async function renderPage(linkId: string = LINK_ID): Promise<Document> {
  const element = await InstallPage({
    params: Promise.resolve({ installLinkId: linkId }),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

beforeEach(() => {
  mocks.fetchPublicInstallData.mockReset();
  mocks.fetchInstallData.mockReset();
  mocks.fetchInstallStatusServer.mockReset().mockResolvedValue(null);
});

describe('InstallPage redesigned layout', () => {
  it('keeps the existing heading and the "Review setup in AWS" CTA', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();

    expect(doc.body.textContent).toContain('Deploy Acme App to your AWS account');
    expect(doc.body.textContent).toContain('Review setup in AWS');
  });

  it('renders the canonical AWS Resources section heading and every detailed AWS resource', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    const section = doc.querySelector('section[aria-labelledby="aws-resources"]');
    expect(section).not.toBeNull();
    const text = section!.textContent ?? '';
    expect(text).toContain('AWS resources');
    // Every detailed AWS resource from the test fixture must still be visible.
    for (const name of [
      'Private network (VPC)',
      'NAT gateway',
      'ECS Fargate service',
      'Application Load Balancer',
      'RDS PostgreSQL database',
      'S3 bucket',
      'IAM roles',
      'Security groups',
      'CloudWatch log group',
      'CloudWatch alarm',
      'Web application',
    ]) {
      expect(text).toContain(name);
    }
    // The customer table groups by the shared `PLAN_COMPONENT_GROUP_DISPLAY`
    // labels — Deployz connector, Application, Data, Networking, Edge,
    // Security, plus Storage/Cache/Messaging when their rows exist.
    for (const group of [
      'Deployz connector',
      'Application',
      'Data',
      'Networking',
      'Edge',
      'Security',
    ]) {
      expect(text).toContain(group);
    }
  });

  it('renders per-resource cost cells and the authoritative total below the table', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    const section = doc.querySelector('section[aria-labelledby="aws-resources"]');
    const text = section!.textContent ?? '';
    // The workload cost cell reads its compact range from the cost item.
    expect(text).toMatch(/~\$9(–11)?/);
    // The database cost cell reads its compact range.
    expect(text).toMatch(/~\$14(–19)?/);
    // S3 (usage_based) reads "Usage-based", not an invented number.
    expect(text).toContain('Usage-based');
    // The connector resources are "Included", not free-priced as "$0".
    expect(text).toContain('Included');
    // The authoritative total renders at the bottom of the table.
    const total = section!.querySelector('[data-testid="install-plan-table-total"]');
    expect(total?.textContent).toContain('~$50–80/month');
  });

  it('marks retained rows with a "Persistent · retained" tag in the Configuration cell', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    // Retained catalog rows in the fixture: RDS database, S3 bucket.
    expect(
      doc.querySelector('[data-testid="install-plan-row-retained-database"]')?.textContent,
    ).toContain('Persistent · retained');
    expect(
      doc.querySelector('[data-testid="install-plan-row-retained-storage_bucket"]')?.textContent,
    ).toContain('Persistent · retained');
    // Non-retained rows must NOT carry the tag.
    expect(
      doc.querySelector('[data-testid="install-plan-row-retained-vpc"]'),
    ).toBeNull();
    expect(
      doc.querySelector('[data-testid="install-plan-row-retained-ecs_service"]'),
    ).toBeNull();
    expect(
      doc.querySelector('[data-testid="install-plan-row-retained-log_group"]'),
    ).toBeNull();
  });

  it('drops the separate Estimated AWS infrastructure card from the fresh install view', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    // The standalone card has its own data-testid; it must not appear on the
    // customer install page anymore.
    expect(doc.querySelector('[data-testid="footprint-cost"]')).toBeNull();
    expect(doc.querySelector('[data-testid="footprint-cost-range"]')).toBeNull();
  });

  it('does not render an "On removal" column', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    const section = doc.querySelector('section[aria-labelledby="aws-resources"]');
    const headings = Array.from(section!.querySelectorAll('thead th')).map((cell) => cell.textContent?.trim() ?? '');
    expect(headings).not.toContain('On removal');
  });

  it('renders the concise cost disclaimer and the retention notice', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    expect(doc.querySelector('[data-testid="install-cost-disclaimer"]')?.textContent).toContain(
      'AWS bills your account directly',
    );
    expect(doc.querySelector('[data-testid="install-retention-warning"]')?.textContent).toContain(
      'Persistent resources are retained',
    );
  });

  it('renders a single Before-you-deploy section with a Security details disclosure trigger', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    const section = doc.querySelector('section[aria-labelledby="before-you-deploy"]');
    expect(section).not.toBeNull();
    const text = section!.textContent ?? '';
    expect(text).toContain('Before you deploy');
    expect(text).toContain('AWS charges are billed directly to you');
    expect(text).toContain('Deployz never sees or stores your AWS credentials');
    // The collapsed disclosure trigger is visible server-side; the link inside
    // the disclosure content only renders once the user opens it.
    expect(text).toContain('Security & permissions details');
  });

  it('does not render the old duplicated infrastructure sections', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    const text = doc.body.textContent ?? '';
    // The three former section headings must not appear as headings anymore.
    expect(text).not.toContain('What Deployz will create');
    expect(text).not.toContain('AWS infrastructure details');
    // "Planned infrastructure" is the vendor surface heading; it must not
    // appear on the customer install page either.
    expect(text).not.toContain('Planned infrastructure');
    // The collapsed disclosure from the shared vendor/admin component must
    // not be present.
    expect(doc.querySelector('[data-testid="aws-infrastructure-details"]')).toBeNull();
  });

  it('surfaces the estimated cost in the header summary', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    expect(doc.querySelector('[data-testid="install-header-cost"]')?.textContent).toContain('~$50–80/month');
  });

  it('renders the existing launch CTA unchanged when quickCreateUrl is present', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({ status: 'ok', data: resolvedData() });

    const doc = await renderPage();
    const cta = Array.from(doc.querySelectorAll('a')).find(
      (anchor) => anchor.textContent?.trim() === 'Review setup in AWS',
    );
    expect(cta).toBeDefined();
    expect(cta?.getAttribute('href')).toBe(QUICK_CREATE);
    expect(cta?.getAttribute('target')).toBe('_blank');
  });

  it('keeps the waiting-for-relay branch unchanged when waitingForRelay is true', async () => {
    mocks.fetchPublicInstallData.mockResolvedValue(null);
    mocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: resolvedData({ waitingForRelay: true, relayStuck: true, deploymentState: 'WAITING_FOR_RELAY' }),
    });

    const doc = await renderPage();
    expect(doc.body.textContent).toContain('setting up inside your AWS account');
    expect(doc.body.textContent).toContain('Still connecting');
    // The redesigned table must not appear on the waiting branch.
    expect(doc.querySelector('[data-testid="install-plan-table-total"]')).toBeNull();
  });
});

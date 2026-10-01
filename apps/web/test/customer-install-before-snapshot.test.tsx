import { writeFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';

import { CustomerInstallReview } from '../src/components/customer-install-review';
import { FootprintCost } from '../src/components/footprint-cost';
import { FootprintSummary } from '../src/components/footprint-summary';
import { InstallPlanComponentTable } from '../src/components/install-plan-component-table';
import { TablePanel } from '../src/components/table-panel';
import { TechnicalDetails } from '../src/components/technical-details';
import { AwsInfrastructureDetails } from '../src/components/aws-infrastructure-details';

import { buildSnapshotFixture } from './customer-install-snapshot.test';

describe('customer install — before snapshot', () => {
  it('renders the prior composition for visual diff against the wireframe', () => {
    const { plan } = buildSnapshotFixture();
    const review = (
      <div className="flex flex-col gap-10">
        <section aria-labelledby="install-resources" className="flex flex-col gap-3">
          <h2 id="install-resources" className="text-base font-semibold">
            What Deployz creates in your AWS account
          </h2>
          <TablePanel>
            <InstallPlanComponentTable plan={plan} />
          </TablePanel>
          <p className="text-sm text-muted-foreground">
            Deployz also creates the Deployz connector, which Deployz uses to create and update this
            deployment. It stays until you delete its stack.
          </p>
          <p className="text-sm text-muted-foreground">
            When this deployment is removed, RDS PostgreSQL database and S3 bucket stay in your AWS
            account.
          </p>
          <TechnicalDetails>
            <FootprintSummary footprint={plan?.footprint ?? null} stage="planned" />
            <AwsInfrastructureDetails plan={plan} />
          </TechnicalDetails>
        </section>
        <FootprintCost estimate={plan?.costEstimate ?? null} />
        <CustomerInstallReview plan={plan} securityHref="/install/abc/security" />
      </div>
    );
    const html = renderToString(review);
    const outPath = process.env['SNIPSHOT_BEFORE_OUT'];
    if (outPath) {
      writeFileSync(outPath, `<!doctype html><html><body style="font-family:system-ui;padding:24px;max-width:920px;margin:auto auto;">${html}</body></html>`);
    }
  });
});
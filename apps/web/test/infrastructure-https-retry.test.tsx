import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InfrastructureSection } from '../src/components/infrastructure-section';
import type { InfrastructureComponent } from '../src/lib/deployments';

import { makeInfrastructureResponse } from './fixtures/infrastructure';

// "Retry HTTPS setup" re-runs the default HTTPS setup. The API folds a
// failed custom domain into the endpoint's HTTPS state, and that retry
// cannot repair it.

function render(customDomainFailed: boolean): string {
  const endpoint: InfrastructureComponent = {
    kind: 'endpoint',
    name: 'Endpoint',
    purpose: 'Serves the application',
    status: 'failed',
    awsService: 'ELB',
    region: 'us-east-2',
    lifecycle: 'delete',
    resources: [],
    httpsState: 'FAILED',
  };
  return renderToString(
    <InfrastructureSection
      data={makeInfrastructureResponse({ components: [endpoint] })}
      deploymentId="dep-1"
      deploymentState="HEALTHY"
      customDomainFailed={customDomainFailed}
    />,
  );
}

describe('Retry HTTPS setup', () => {
  it('is offered when the default HTTPS setup failed', () => {
    expect(render(false)).toContain('Retry HTTPS setup');
  });

  it('is not offered when the custom domain is the failure', () => {
    expect(render(true)).not.toContain('Retry HTTPS setup');
  });
});

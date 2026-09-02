import { expect, type APIRequestContext } from '@playwright/test';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

/**
 * Phase 2 readiness gate: `POST /api/deployments` refuses applications whose
 * normalized deployment manifest is not READY. The demo repos these specs
 * seed have no real analysis, so give the application the same vendor
 * overrides the scenario fixtures use — just the three fields the readiness
 * evaluator hard-fails on (Dockerfile, port, start command).
 */
export async function makeApplicationDeployable(
  request: APIRequestContext,
  applicationId: string,
): Promise<void> {
  const response = await request.patch(`${API_URL}/api/applications/${applicationId}`, {
    data: {
      containerPort: 3000,
      dockerfilePath: 'Dockerfile',
      startCommand: 'npm start',
    },
  });
  expect(
    response.ok(),
    `makeApplicationDeployable failed: ${response.status()} ${await response.text()}`,
  ).toBeTruthy();
}

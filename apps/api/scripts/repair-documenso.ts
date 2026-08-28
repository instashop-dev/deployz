/**
 * One-off, idempotent repair for the audited Documenso deployment whose
 * v0.1.5 release row drifted from what actually runs in AWS.
 *
 *   deployment  7306755d-f467-4f56-8076-d4895230f794
 *   AWS account 151955775369
 *   release     v0.1.5
 *
 * Resolves the image digest from ECR (tag v0.1.5 in deployz-images), then —
 * only if the database still matches the audited stale state — sets the
 * release READY with that digest and repairs the deployment pointers. A
 * second run finds the repaired state and exits without writing.
 *
 * Run from apps/api with vendor AWS credentials and DATABASE_URL set:
 *   pnpm --filter @deployz/api exec tsx scripts/repair-documenso.ts
 */

import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { and, eq } from 'drizzle-orm';

import { createRuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

const DEPLOYMENT_ID = '7306755d-f467-4f56-8076-d4895230f794';
const EXPECTED_ACCOUNT = '151955775369';
const VERSION = 'v0.1.5';
const ECR_REPOSITORY = 'deployz-images';

async function resolveDigestFromEcr(): Promise<string> {
  const ecr = new ECRClient({});
  const response = await ecr.send(
    new DescribeImagesCommand({
      repositoryName: ECR_REPOSITORY,
      imageIds: [{ imageTag: VERSION }],
    }),
  );
  const image = response.imageDetails?.[0];
  const digest = image?.imageDigest;
  if (!image?.registryId || !digest?.startsWith('sha256:')) {
    throw new Error(`ECR has no digest for ${ECR_REPOSITORY}:${VERSION}`);
  }
  const region = await ecr.config.region();
  return `${image.registryId}.dkr.ecr.${region}.amazonaws.com/${ECR_REPOSITORY}@${digest}`;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must point at the production control plane');
  }
  const db = await createRuntimeDb();

  const deploymentRows = await db
    .select()
    .from(schema.deployments)
    .where(eq(schema.deployments.id, DEPLOYMENT_ID))
    .limit(1);
  const deployment = deploymentRows[0];
  if (!deployment) {
    throw new Error(`deployment ${DEPLOYMENT_ID} not found — wrong database?`);
  }

  const releaseRows = await db
    .select()
    .from(schema.releases)
    .where(
      // Scoped by application + version so a same-named release in another
      // application can never be repaired by mistake.
      and(
        eq(schema.releases.applicationId, deployment.applicationId),
        eq(schema.releases.version, VERSION),
      ),
    )
    .limit(1);
  const release = releaseRows[0];
  if (!release) {
    throw new Error(`release ${VERSION} not found for the deployment's application`);
  }

  const before = {
    releaseStatus: release.releaseStatus,
    buildStatus: release.buildStatus,
    imageDigest: release.imageDigest,
    deploymentCurrentReleaseId: deployment.currentReleaseId,
    deploymentAwsAccountId: deployment.awsAccountId,
  };
  console.log('before:', JSON.stringify(before, null, 2));

  const alreadyRepaired =
    release.releaseStatus === 'READY' &&
    release.imageDigest !== null &&
    deployment.currentReleaseId === release.id &&
    deployment.awsAccountId === EXPECTED_ACCOUNT;

  if (alreadyRepaired) {
    console.log('already repaired — nothing to do');
    return;
  }

  // Preconditions matching the audited stale state: the release never became
  // READY with a digest, and the deployment never pointed at it with the
  // account recorded. Anything else means the world moved on — refuse
  // rather than overwrite whatever is now true.
  if (release.releaseStatus === 'READY' && release.imageDigest !== null) {
    throw new Error(`release ${VERSION} is already READY with a digest — refusing to overwrite`);
  }
  if (deployment.awsAccountId !== null && deployment.awsAccountId !== EXPECTED_ACCOUNT) {
    throw new Error(
      `deployment account is ${deployment.awsAccountId}, expected null or ${EXPECTED_ACCOUNT}`,
    );
  }

  const fullDigest = await resolveDigestFromEcr();
  console.log(`resolved digest from ECR: ${fullDigest}`);

  await db.transaction(async (tx) => {
    await tx
      .update(schema.releases)
      .set({
        releaseStatus: 'READY',
        buildStatus: 'SUCCEEDED',
        imageDigest: fullDigest,
      })
      .where(eq(schema.releases.id, release.id));
    await tx
      .update(schema.deployments)
      .set({
        previousReleaseId: deployment.currentReleaseId,
        currentReleaseId: release.id,
        awsAccountId: EXPECTED_ACCOUNT,
      })
      .where(eq(schema.deployments.id, deployment.id));
  });

  console.log('after:', {
    releaseStatus: 'READY',
    buildStatus: 'SUCCEEDED',
    imageDigest: fullDigest,
    deploymentCurrentReleaseId: release.id,
    deploymentAwsAccountId: EXPECTED_ACCOUNT,
  });
  console.log('repair complete (no deploy event recorded)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

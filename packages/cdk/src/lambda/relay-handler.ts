/**
 * Relay Lambda handler (bootstrap) — placeholder.
 *
 * The relay is the OUTBOUND actor in the customer's AWS account. It polls the
 * Deployz control plane on a fixed schedule (egress-only — the control plane
 * never reaches INTO the customer account). On its FIRST poll it registers the
 * installation with the control plane (install ID ↔ credential token binding),
 * then polls for commands on a fixed vocabulary.
 *
 * The real command vocabulary + idempotency + token rotation arrive in todo 12.
 * This handler only exercises the phase-1 surface: read the installation
 * identity from the environment and write a structured poll marker to
 * CloudWatch Logs. It deliberately CANNOT read logs back — the §16 data
 * boundary (no `logs:GetLogEvents` / `logs:FilterLogEvents`) is enforced at
 * IAM, not in code.
 */
import type { ScheduledEvent } from 'aws-lambda';

export async function handler(event: ScheduledEvent): Promise<void> {
  const installationId = process.env['DEPLOYZ_INSTALLATION_ID'] ?? 'unknown';
  const secretArn = process.env['DEPLOYZ_CREDENTIAL_SECRET_ARN'] ?? '';
  const controlPlaneUrl = process.env['DEPLOYZ_CONTROL_PLANE_URL'] ?? '';

  // Structured poll marker — operational metadata only (§15: no raw app logs
  // ever leave the customer account). Todo 12 replaces this with the real
  // register-then-poll flow reading the token from Secrets Manager.
  console.log(
    JSON.stringify({
      event: 'relay:first-contact-ready',
      installationId,
      secretArn,
      controlPlaneUrl,
      scheduledAt: event.time ?? new Date().toISOString(),
    }),
  );
}

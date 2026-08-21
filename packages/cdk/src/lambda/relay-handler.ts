/**
 * Relay Lambda handler (bootstrap) — delegates to @deployz/relay.
 *
 * The relay is the OUTBOUND actor in the customer's AWS account. It polls the
 * Deployz control plane on a fixed schedule (egress-only — the control plane
 * never reaches INTO the customer account). On its FIRST poll it registers the
 * installation with the control plane (install ID ↔ credential token binding),
 * then polls for commands on a fixed vocabulary.
 *
 * The real command vocabulary + idempotency + token rotation live in
 * @deployz/relay (todo 12). This file is the CDK entry point that the
 * NodejsFunction bundles via esbuild.
 *
 * §16 data boundary: the relay writes operational logs but deliberately
 * CANNOT read them back (no `logs:GetLogEvents` / `logs:FilterLogEvents`).
 * This is enforced at IAM in the bootstrap stack, not in code.
 */
export { handler } from '@deployz/relay';
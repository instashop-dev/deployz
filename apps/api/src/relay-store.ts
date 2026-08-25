import crypto from 'node:crypto';

// §14/§39 relay bearer-token binding.
//
// The relay authenticates with a bearer token it reads from the credential
// secret CloudFormation minted inside the CUSTOMER's account. The control
// plane cannot know that token in advance, so it learns it once — at
// enrollment — and remembers it from then on.
//
// The binding lives in Postgres (deployments.relay_token_hash), not in a
// process-local map, and only the sha256 of the token is stored. Both of
// those are load-bearing:
//
//   - In memory, every API restart forgot the binding, so the next caller to
//     present ANY token became the relay for that installation.
//   - Registration used to bind whatever token the caller supplied, checking
//     only that the installation id existed. The id travelled in the
//     customer's install URL, so anyone holding that link could rebind the
//     deployment to a token of their own, lock the real relay out, read its
//     job payloads and drive the deployment's state — including into and out
//     of the states that start and stop billing.
//
// Enrollment is therefore single-use (see the register route), and this
// module only answers "is this the token that was bound?".

/** sha256 of a relay bearer token, hex-encoded. */
export function hashRelayToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of a presented token against a stored hash.
 *
 * Both sides are fixed-length hex digests, so the length guard below can
 * never be a length oracle on the token itself — it only rejects a malformed
 * or absent hash, which timingSafeEqual would otherwise throw on.
 */
export function verifyRelayToken(storedHash: string | null, presentedToken: string): boolean {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, 'utf8');
  const presented = Buffer.from(hashRelayToken(presentedToken), 'utf8');
  if (expected.length !== presented.length) return false;
  return crypto.timingSafeEqual(expected, presented);
}

/**
 * Verify against the current token or, during rotation, the previous one.
 *
 * The relay rotates by adopting a new token and sending the old one in
 * `X-Deployz-Old-Token` for a grace window (see packages/relay/src/auth.ts).
 * Accepting either keeps a rotating relay authenticated across the window.
 */
export function verifyRelayTokenWithRotation(
  storedHash: string | null,
  presentedToken: string,
  oldToken: string | undefined,
): boolean {
  if (verifyRelayToken(storedHash, presentedToken)) return true;
  return oldToken !== undefined && verifyRelayToken(storedHash, oldToken);
}

/** A fresh single-use enrollment code. */
export function mintEnrollmentCode(): string {
  return crypto.randomBytes(32).toString('hex');
}

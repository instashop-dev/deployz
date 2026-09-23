import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// §31 secure secret storage: AES-256-GCM encryption for the plaintext value
// behind a config secret row, so a vendor default or customer override can
// actually be delivered later (build args, post-install CONFIG_UPDATE)
// instead of being discarded once SECRET_MASK is written. Never logged,
// never returned by any API — see apps/api/src/config.ts.
//
// Key material precedence:
//  1. env CONFIG_ENCRYPTION_KEY — local dev / tests, explicit override.
//  2. Secrets Manager at env CONFIG_ENCRYPTION_SECRET_ARN — the CDK-generated
//     control-plane secret, read-granted to the API and worker Lambdas. The
//     secret STRING itself is the key material (fetched once, cached).
//  3. A fixed dev key, ONLY when not running in Lambda (AWS_LAMBDA_FUNCTION_NAME
//     unset) — so a fresh local checkout with no .env still works.
//  4. Otherwise: throw. A Lambda with neither var configured must never
//     silently store an undeliverable secret.
const DEV_KEY_MATERIAL = 'deployz-local-dev-config-encryption-key-do-not-use-in-production';

const FORMAT_VERSION = 'v1';
const GCM_IV_LENGTH = 12;

let cachedSecretPromise: Promise<string> | null = null;

async function fetchCachedSecretString(secretArn: string): Promise<string> {
  cachedSecretPromise ??= (async () => {
    const client = new SecretsManagerClient({});
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) {
      throw new Error('CONFIG_ENCRYPTION_SECRET_ARN resolved to a secret with no string value');
    }
    return response.SecretString;
  })();
  return cachedSecretPromise;
}

async function resolveKeyMaterial(): Promise<string> {
  const envKey = process.env.CONFIG_ENCRYPTION_KEY;
  if (envKey) return envKey;

  const secretArn = process.env.CONFIG_ENCRYPTION_SECRET_ARN;
  if (secretArn) return fetchCachedSecretString(secretArn);

  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return DEV_KEY_MATERIAL;

  throw new Error(
    'No config encryption key is configured: set CONFIG_ENCRYPTION_KEY or CONFIG_ENCRYPTION_SECRET_ARN.',
  );
}

/** SHA-256 of the resolved key material — a fixed-length AES-256 key regardless of the material's own length. */
async function deriveKey(): Promise<Buffer> {
  const material = await resolveKeyMaterial();
  return createHash('sha256').update(material).digest();
}

/** Encrypt a plaintext config value. Format: `v1:<iv b64>:<tag b64>:<ciphertext b64>`. */
export async function encryptConfigValue(plain: string): Promise<string> {
  const key = await deriveKey();
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/** Decrypt a value produced by `encryptConfigValue`. Throws on a bad format, a tampered ciphertext, or the wrong key. */
export async function decryptConfigValue(stored: string): Promise<string> {
  const parts = stored.split(':');
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (parts.length !== 4 || version !== FORMAT_VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Unrecognized encrypted config value format');
  }

  const key = await deriveKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plain.toString('utf8');
}

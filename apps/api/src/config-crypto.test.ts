import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decryptConfigValue, encryptConfigValue } from './config-crypto.js';

// §31 secure secret storage — AES-256-GCM roundtrip, tamper detection, and
// key-resolution behaviour. Tests run outside a Lambda (AWS_LAMBDA_FUNCTION_NAME
// unset), so with no CONFIG_ENCRYPTION_KEY the module falls back to its fixed
// dev key — no AWS calls, no real Secrets Manager needed.

const ORIGINAL_KEY = process.env.CONFIG_ENCRYPTION_KEY;
const ORIGINAL_LAMBDA_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;

beforeEach(() => {
  delete process.env.CONFIG_ENCRYPTION_KEY;
  delete process.env.CONFIG_ENCRYPTION_SECRET_ARN;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = ORIGINAL_KEY;
  if (ORIGINAL_LAMBDA_NAME === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  else process.env.AWS_LAMBDA_FUNCTION_NAME = ORIGINAL_LAMBDA_NAME;
});

describe('config-crypto — roundtrip', () => {
  it('decrypts exactly what was encrypted', async () => {
    const plain = 'sk_live_super_secret_value';
    const stored = await encryptConfigValue(plain);
    expect(await decryptConfigValue(stored)).toBe(plain);
  });

  it('encrypts the empty string and every unicode value round-trips', async () => {
    const plain = '🔒 secret — with spaces & 中文';
    const stored = await encryptConfigValue(plain);
    expect(await decryptConfigValue(stored)).toBe(plain);
  });

  it('never emits the plaintext inside the stored ciphertext string', async () => {
    const plain = 'unmistakable-plaintext-marker';
    const stored = await encryptConfigValue(plain);
    expect(stored).not.toContain(plain);
  });
});

describe('config-crypto — format', () => {
  it('produces the documented v1:<iv>:<tag>:<ciphertext> shape', async () => {
    const stored = await encryptConfigValue('value');
    const parts = stored.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    for (const part of parts.slice(1)) {
      expect(() => Buffer.from(part!, 'base64')).not.toThrow();
    }
  });

  it('rejects a value with the wrong number of segments', async () => {
    await expect(decryptConfigValue('v1:onlytwo')).rejects.toThrow();
  });

  it('rejects an unrecognized version prefix', async () => {
    const stored = await encryptConfigValue('value');
    const [, iv, tag, ciphertext] = stored.split(':');
    await expect(decryptConfigValue(`v2:${iv}:${tag}:${ciphertext}`)).rejects.toThrow();
  });
});

describe('config-crypto — tamper detection', () => {
  it('fails to decrypt a ciphertext that was modified after encryption', async () => {
    const stored = await encryptConfigValue('sensitive-value');
    const [version, iv, tag, ciphertext] = stored.split(':');
    const tamperedByte = Buffer.from(ciphertext!, 'base64');
    tamperedByte[0] = (tamperedByte[0] ?? 0) ^ 0xff;
    const tampered = `${version}:${iv}:${tag}:${tamperedByte.toString('base64')}`;
    await expect(decryptConfigValue(tampered)).rejects.toThrow();
  });

  it('fails to decrypt when the auth tag was modified', async () => {
    const stored = await encryptConfigValue('sensitive-value');
    const [version, iv, tag, ciphertext] = stored.split(':');
    const tamperedTag = Buffer.from(tag!, 'base64');
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 0xff;
    const tampered = `${version}:${iv}:${tamperedTag.toString('base64')}:${ciphertext}`;
    await expect(decryptConfigValue(tampered)).rejects.toThrow();
  });
});

describe('config-crypto — key resolution', () => {
  it('a value encrypted under one CONFIG_ENCRYPTION_KEY fails to decrypt under another', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = 'key-material-one';
    const stored = await encryptConfigValue('cross-key-value');

    process.env.CONFIG_ENCRYPTION_KEY = 'key-material-two';
    await expect(decryptConfigValue(stored)).rejects.toThrow();
  });

  it('roundtrips using an explicit CONFIG_ENCRYPTION_KEY', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = 'a-specific-local-dev-key';
    const stored = await encryptConfigValue('explicit-key-value');
    expect(await decryptConfigValue(stored)).toBe('explicit-key-value');
  });

  it('throws in a simulated Lambda environment with no key configured', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'deployz-api';
    await expect(encryptConfigValue('value')).rejects.toThrow(
      /No config encryption key is configured/,
    );
  });
});

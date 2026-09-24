import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KMS_CIPHERTEXT_PREFIX,
  createCipherStub,
  createKmsCipher,
  createSecretCipherFromEnv,
} from './pending-secrets.js';

// A fake KMS: the "blob" is JSON of {context, plaintext}; Decrypt fails unless
// the caller sends exactly the context the value was encrypted with.
const kmsCalls: { command: string; input: { KeyId?: string; EncryptionContext?: Record<string, string> } }[] = [];
vi.mock('@aws-sdk/client-kms', () => {
  class EncryptCommand {
    constructor(readonly input: { KeyId: string; Plaintext: Uint8Array; EncryptionContext: Record<string, string> }) {}
  }
  class DecryptCommand {
    constructor(readonly input: { KeyId: string; CiphertextBlob: Uint8Array; EncryptionContext: Record<string, string> }) {}
  }
  class KMSClient {
    async send(command: EncryptCommand | DecryptCommand) {
      if (command instanceof EncryptCommand) {
        kmsCalls.push({ command: 'Encrypt', input: command.input });
        const blob = JSON.stringify({
          context: command.input.EncryptionContext,
          plaintext: new TextDecoder().decode(command.input.Plaintext),
        });
        return { CiphertextBlob: new TextEncoder().encode(blob) };
      }
      kmsCalls.push({ command: 'Decrypt', input: command.input });
      const blob = JSON.parse(new TextDecoder().decode(command.input.CiphertextBlob)) as {
        context: Record<string, string>;
        plaintext: string;
      };
      if (JSON.stringify(blob.context) !== JSON.stringify(command.input.EncryptionContext)) {
        throw Object.assign(new Error('InvalidCiphertextException'), { name: 'InvalidCiphertextException' });
      }
      return { Plaintext: new TextEncoder().encode(blob.plaintext) };
    }
  }
  return { KMSClient, EncryptCommand, DecryptCommand };
});

const KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const context = { organizationId: 'org-1', applicationId: 'app-1', key: 'API_TOKEN', scope: 'vendor' };

beforeEach(() => {
  kmsCalls.length = 0;
});

describe('createSecretCipherFromEnv', () => {
  it('fails closed in Lambda when the key ARN is absent', () => {
    expect(() => createSecretCipherFromEnv({ kmsKeyArn: undefined, isLambda: true })).toThrow(
      /DEPLOYZ_KMS_KEY_ARN is not set/,
    );
    expect(() => createSecretCipherFromEnv({ kmsKeyArn: '  ', isLambda: true })).toThrow(
      /DEPLOYZ_KMS_KEY_ARN is not set/,
    );
  });

  it('fails closed on an invalid key ARN without echoing it', () => {
    const bad = 'alias/not-a-key-arn';
    let message = '';
    try {
      createSecretCipherFromEnv({ kmsKeyArn: bad, isLambda: true });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('DEPLOYZ_KMS_KEY_ARN is not a valid KMS key ARN.');
    expect(() => createSecretCipherFromEnv({ kmsKeyArn: bad, isLambda: false })).toThrow();
  });

  it('selects KMS in Lambda when the key ARN is valid', async () => {
    const cipher = createSecretCipherFromEnv({ kmsKeyArn: KEY_ARN, isLambda: true });
    const { ciphertext } = await cipher.encrypt('s3cret', context);
    expect(ciphertext.startsWith(KMS_CIPHERTEXT_PREFIX)).toBe(true);
    expect(kmsCalls[0]?.input.KeyId).toBe(KEY_ARN);
  });

  it('selects the stub only outside Lambda with no key', async () => {
    const cipher = createSecretCipherFromEnv({ kmsKeyArn: undefined, isLambda: false });
    const { ciphertext } = await cipher.encrypt('s3cret', context);
    expect(ciphertext.startsWith('enc:')).toBe(true);
    expect(kmsCalls).toHaveLength(0);
  });
});

describe('createKmsCipher', () => {
  it('writes kms1: ciphertext, adds the purpose context, and round-trips', async () => {
    const cipher = createKmsCipher(KEY_ARN);
    const { ciphertext, encryptionContext } = await cipher.encrypt('s3cret', context);
    expect(ciphertext.startsWith('kms1:')).toBe(true);
    expect(ciphertext).not.toContain('s3cret');
    // The caller stores its own context; the cipher owns `purpose`.
    expect(encryptionContext).toEqual(context);
    expect(kmsCalls[0]?.input.EncryptionContext).toEqual({ ...context, purpose: 'deployz-config-secret' });
    await expect(cipher.decrypt(ciphertext, context)).resolves.toBe('s3cret');
    expect(kmsCalls[1]?.input).toMatchObject({
      KeyId: KEY_ARN,
      EncryptionContext: { ...context, purpose: 'deployz-config-secret' },
    });
  });

  it('fails decrypt on a context mismatch', async () => {
    const cipher = createKmsCipher(KEY_ARN);
    const { ciphertext } = await cipher.encrypt('s3cret', context);
    await expect(cipher.decrypt(ciphertext, { ...context, applicationId: 'app-2' })).rejects.toThrow(
      'InvalidCiphertextException',
    );
  });

  it('refuses legacy stub ciphertext without calling KMS', async () => {
    const legacy = (await createCipherStub().encrypt('s3cret', context)).ciphertext;
    await expect(createKmsCipher(KEY_ARN).decrypt(legacy, context)).rejects.toThrow(/not in the kms1 format/);
    await expect(createKmsCipher(KEY_ARN).decrypt('AQIDBA==', context)).rejects.toThrow(/not in the kms1 format/);
    expect(kmsCalls).toHaveLength(0);
  });

  it('rejects a caller-supplied purpose or an unknown context key', async () => {
    const cipher = createKmsCipher(KEY_ARN);
    await expect(cipher.encrypt('s3cret', { ...context, purpose: 'other' })).rejects.toThrow(/"purpose"/);
    await expect(cipher.encrypt('s3cret', { ...context, email: 'a@b.test' })).rejects.toThrow(/"email"/);
    expect(kmsCalls).toHaveLength(0);
  });
});

describe('createCipherStub', () => {
  it('fails decrypt on a context mismatch', async () => {
    const stub = createCipherStub();
    const { ciphertext } = await stub.encrypt('s3cret', context);
    await expect(stub.decrypt(ciphertext, { ...context, key: 'OTHER' })).rejects.toThrow(/mismatch/);
  });
});

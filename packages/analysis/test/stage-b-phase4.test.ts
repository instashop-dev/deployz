import { describe, expect, it } from 'vitest';

import { detectEnvVarModel, type FileTree } from '../src/detectors.js';

function modelByKey(tree: FileTree) {
  return new Map(detectEnvVarModel(tree).map((entry) => [entry.key, entry]));
}

const SECRET_READS_TREE: FileTree = {
  'src/env.ts': [
    'const a = process.env.AUTH_SECRET;',
    'const b = process.env.NEXTAUTH_SECRET;',
    'const c = process.env.ENCRYPTION_KEY;',
    'const d = process.env.OPENAI_API_KEY;',
    'const e = process.env.STRIPE_SECRET_KEY;',
    'const f = process.env.SENDGRID_API_KEY;',
    'const g = process.env.GOOGLE_CLIENT_SECRET;',
    'const h = process.env.DATABASE_URL;',
    "const i = process.env.OPTIONAL_SECRET || 'fallback';",
    '',
  ].join('\n'),
};

describe('generatable internal secrets (Stage B phase 4)', () => {
  it('flags required application-INTERNAL secrets as generatable', () => {
    const byKey = modelByKey(SECRET_READS_TREE);
    expect(byKey.get('AUTH_SECRET')).toMatchObject({ required: true, generatable: true });
    expect(byKey.get('NEXTAUTH_SECRET')).toMatchObject({ required: true, generatable: true });
    expect(byKey.get('ENCRYPTION_KEY')).toMatchObject({ required: true, generatable: true });
  });

  it('never flags external vendor credentials or provisioned bindings', () => {
    const byKey = modelByKey(SECRET_READS_TREE);
    expect(byKey.get('OPENAI_API_KEY')).toMatchObject({
      required: true,
      purpose: 'external_credential',
    });
    expect(byKey.get('STRIPE_SECRET_KEY')).toMatchObject({
      purpose: 'external_credential',
    });
    expect(byKey.get('SENDGRID_API_KEY')).toMatchObject({
      purpose: 'external_credential',
    });
    // A vendor-credential shape outside the §11.3 catalog is still not
    // generatable (the double-guard, even though purpose logic already marks
    // it external).
    expect(byKey.get('GOOGLE_CLIENT_SECRET')).toMatchObject({
      purpose: 'external_credential',
    });
    expect(byKey.get('DATABASE_URL')).toMatchObject({
      purpose: 'infrastructure_binding',
    });
    for (const key of [
      'OPENAI_API_KEY',
      'STRIPE_SECRET_KEY',
      'SENDGRID_API_KEY',
      'GOOGLE_CLIENT_SECRET',
      'DATABASE_URL',
      'OPTIONAL_SECRET',
    ]) {
      // `generatable` is omitted (undefined) for everything Deployz must not generate.
      expect(byKey.get(key)?.generatable, `${key} must not be generatable`).toBeUndefined();
    }
  });

  it('keeps an optional secret-looking variable vendor-supplied (not generatable)', () => {
    const byKey = modelByKey(SECRET_READS_TREE);
    expect(byKey.get('OPTIONAL_SECRET')).toMatchObject({ required: false });
    expect(byKey.get('OPTIONAL_SECRET')!.generatable).toBeUndefined();
  });

  it('is stored on the analysed manifest variables', () => {
    const model = detectEnvVarModel(SECRET_READS_TREE);
    const byKey = new Map(model.map((entry) => [entry.key, entry]));
    expect(byKey.get('NEXTAUTH_SECRET')).toMatchObject({ generatable: true });
    expect(byKey.get('OPENAI_API_KEY')!.generatable).toBeUndefined();
  });
});


import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.next/**',
      '**/cdk.out/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_`-prefixed bindings are the accepted marker for intentionally
      // discarded destructured fields (e.g. stripping secrets from a row).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Lightweight UI-system guardrails for apps/web (docs/ui-system.md).
    // Deliberately narrow: a handful of deterministic checks, no custom
    // plugin, nothing that argues about subjective design decisions.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: [
      // shadcn primitives themselves are upstream code.
      'apps/web/src/components/ui/**',
      // The single sanctioned raw-palette spot: status tones with no
      // semantic theme token (amber for "degraded", emerald for "ready").
      'apps/web/src/lib/deployment-vocabulary.ts',
      'apps/web/src/components/readiness-result.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'antd',
            '@mui/material',
            '@emotion/react',
            '@emotion/styled',
            '@chakra-ui/react',
            '@headlessui/react',
            '@mantine/core',
            'semantic-ui-react',
            '@primer/react',
            'styled-components',
          ].map((name) => ({
            name,
            message: 'Deployz uses shadcn/ui as its only UI system (docs/ui-system.md).',
          })),
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Literal[value=/\\b(?:bg|text|border|ring|fill|stroke|outline|decoration|divide|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}\\b/]",
          message:
            'Use semantic theme tokens (bg-background, text-muted-foreground, text-destructive, …) instead of arbitrary Tailwind palette colors (docs/ui-system.md).',
        },
        {
          selector:
            "Literal[value=/\\b(?:CREATE|UPDATE|DELETE|ROLLBACK|REVIEW)(?:_ROLLBACK)?_(?:COMPLETE|IN_PROGRESS|FAILED|CLEANUP_IN_PROGRESS|CLEANUP_COMPLETE)\\b/]",
          message:
            'Raw CloudFormation lifecycle statuses stay out of customer-facing code; map them through @/lib/deployment-vocabulary instead (docs/ui-system.md).',
        },
        {
          selector:
            "JSXText[value=/\\b(?:CREATE|UPDATE|DELETE|ROLLBACK|REVIEW)(?:_ROLLBACK)?_(?:COMPLETE|IN_PROGRESS|FAILED|CLEANUP_IN_PROGRESS|CLEANUP_COMPLETE)\\b/]",
          message:
            'Raw CloudFormation lifecycle statuses stay out of customer-facing JSX; map them through @/lib/deployment-vocabulary instead (docs/ui-system.md).',
        },
      ],
    },
  },
);

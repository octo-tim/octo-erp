import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'src/generated/**',
      'next-env.d.ts',
      'storage/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // INT-01 / ADR-0011: money and quantity never go through floats
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'INT-01: use src/lib/money.ts (decimal.js) instead of parseFloat',
        },
        {
          selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
          message: 'INT-01: use src/lib/money.ts (decimal.js) instead of Number.parseFloat',
        },
      ],
    },
  },
  {
    // docs/engineering-rules.md §1.5: modules receive ctx.tx and never open their own transaction
    files: ['src/server/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/server/db',
              message: 'Modules receive ctx.tx; never import the global prisma client.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'tools/**/*.{ts,mjs}', 'prisma/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-restricted-imports': 'off' },
  },
);

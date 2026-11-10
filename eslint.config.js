import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// @chatwarden/core must stay portable (it runs in a browser) and dependency-free: it may import nothing from a
// node: module, not even node:crypto (see src/crypto.ts for the process.getBuiltinModule route). Applies to src only;
// tests may use node:crypto as the reference implementation.
const coreRestrictedImports = [
  'error',
  {
    paths: ['fs', 'path', 'net', 'http', 'sqlite', 'crypto', 'os', 'util', 'buffer'].map((name) => ({
      name,
      message: `@chatwarden/core must not import "${name}".`,
    })),
    patterns: [
      {
        group: ['node:*'],
        message: '@chatwarden/core src may not import node: modules; it must run in a browser (use src/crypto.ts).',
      },
      {
        group: ['fs/*', 'path/*'],
        message: '@chatwarden/core must not import fs or path.',
      },
    ],
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.superpowers/**', '**/*.tsbuildinfo', '.smoke/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: { 'no-restricted-imports': coreRestrictedImports },
  },
);

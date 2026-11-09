import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// @chatwarden/core must stay portable and dependency-free: the only node:
// built-in it may import is node:crypto.
const coreRestrictedImports = [
  'error',
  {
    paths: ['fs', 'path', 'net', 'http', 'sqlite'].map((name) => ({
      name,
      message: `@chatwarden/core must not import "${name}".`,
    })),
    patterns: [
      {
        group: ['node:*', '!node:crypto'],
        message: '@chatwarden/core may import nothing from node: except node:crypto.',
      },
      {
        group: ['fs/*', 'path/*'],
        message: '@chatwarden/core must not import fs or path.',
      },
    ],
  },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.superpowers/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/core/**/*.ts'],
    rules: { 'no-restricted-imports': coreRestrictedImports },
  },
);

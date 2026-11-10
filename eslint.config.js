import js from '@eslint/js';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

// @chatwarden/core and @chatwarden/store-memory must stay portable (they run in a browser) and dependency-free: their src
// may import nothing from a node: module or any Node builtin, not even node:crypto (see core's src/crypto.ts for the
// process.getBuiltinModule route). Applies to src only; tests may use node:crypto as the reference implementation.
const builtins = builtinModules.filter((name) => !name.startsWith('_') && !name.startsWith('node:') && !name.includes('/'));
const BROWSER_SAFE_MESSAGE = 'this package must run in a browser: src may import no Node builtin (core: use src/crypto.ts).';
const browserSafeImports = [
  'error',
  {
    paths: builtins.map((name) => ({ name, message: BROWSER_SAFE_MESSAGE })),
    patterns: [
      { group: ['node:*'], message: BROWSER_SAFE_MESSAGE },
      { group: builtins.map((name) => `${name}/*`), message: BROWSER_SAFE_MESSAGE },
    ],
  },
];
// no-restricted-imports does not see a dynamic import(); a selector does. (An esquery regex ends at the next "/", so a
// subpath slash is written \x2f.)
const browserSafeSyntax = [
  'error',
  { selector: 'ImportExpression[source.value=/^node:/]', message: BROWSER_SAFE_MESSAGE },
  { selector: `ImportExpression[source.value=/^(${builtins.join('|')})(\\x2f.*)?$/]`, message: BROWSER_SAFE_MESSAGE },
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
    files: ['packages/core/src/**/*.ts', 'packages/store-memory/src/**/*.ts'],
    rules: { 'no-restricted-imports': browserSafeImports, 'no-restricted-syntax': browserSafeSyntax },
  },
);

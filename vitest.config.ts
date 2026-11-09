import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript source, so tests need no prior `tsc -b`.
    // Order matters: the more specific `@chatwarden/matcher/test-fixtures` must come before `@chatwarden/matcher`.
    alias: [
      {
        find: '@chatwarden/core',
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/store-sqlite',
        replacement: fileURLToPath(new URL('./packages/store-sqlite/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/matcher/test-fixtures',
        replacement: fileURLToPath(new URL('./packages/matcher/test/fixtures/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/matcher',
        replacement: fileURLToPath(new URL('./packages/matcher/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/profanity',
        replacement: fileURLToPath(new URL('./packages/profanity/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./packages/store-sqlite/test/setup.ts'],
  },
});

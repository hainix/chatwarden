import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript source, so tests need no prior `tsc -b`.
    // Order matters: the more specific `@chatwarden/matcher/fixtures` subpaths must come before `@chatwarden/matcher`.
    alias: [
      {
        find: '@chatwarden/core',
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/store-memory',
        replacement: fileURLToPath(new URL('./packages/store-memory/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/store-sqlite',
        replacement: fileURLToPath(new URL('./packages/store-sqlite/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/matcher/test-fixtures',
        replacement: fileURLToPath(new URL('./packages/matcher/src/fixtures/testFixtures.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/matcher/fixtures',
        replacement: fileURLToPath(new URL('./packages/matcher/src/fixtures/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/matcher',
        replacement: fileURLToPath(new URL('./packages/matcher/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/profanity',
        replacement: fileURLToPath(new URL('./packages/profanity/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/discord',
        replacement: fileURLToPath(new URL('./packages/discord/src/index.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/http/express',
        replacement: fileURLToPath(new URL('./packages/http/src/express.ts', import.meta.url)),
      },
      {
        find: '@chatwarden/http',
        replacement: fileURLToPath(new URL('./packages/http/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/*.test.ts', 'scripts/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./packages/store-sqlite/test/setup.ts'],
  },
});

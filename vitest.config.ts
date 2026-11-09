import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript source, so tests need no prior `tsc -b`.
    alias: {
      '@chatwarden/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./packages/store-sqlite/test/setup.ts'],
  },
});

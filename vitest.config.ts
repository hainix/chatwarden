import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { hubElementPlugin } from './packages/hub-element/build/plugin.mjs';

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
        find: '@chatwarden/http/admin',
        replacement: fileURLToPath(new URL('./packages/http/src/admin-entry.ts', import.meta.url)),
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
    // Four projects, so no test file runs twice: the kit's tests run in Node; the UIs' tests (hub-react, player-react, hub-element) need a DOM (jsdom).
    projects: [
      {
        extends: true,
        test: {
          name: 'kit',
          include: ['packages/*/test/**/*.test.ts', 'examples/*/*.test.ts', 'scripts/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'packages/hub-react/**', 'packages/player-react/**', 'packages/hub-element/**'],
          setupFiles: ['./packages/store-sqlite/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'hub-react',
          environment: 'jsdom',
          include: ['packages/hub-react/test/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          setupFiles: ['./packages/hub-react/test/setup.ts'],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'player-react',
          environment: 'jsdom',
          include: ['packages/player-react/test/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          setupFiles: ['./packages/player-react/test/setup.ts'],
          testTimeout: 30_000,
        },
      },
      {
        // The element bundles hub-react: its tests run against hub-react's source, with the same build plugin the script is built with
        // (it supplies the hub CSS as a string; hub-react's own sources are used as they are).
        extends: true,
        plugins: [hubElementPlugin()],
        resolve: {
          alias: [
            {
              find: '@chatwarden/hub-react/headless',
              replacement: fileURLToPath(new URL('./packages/hub-react/src/headless/index.ts', import.meta.url)),
            },
            {
              find: '@chatwarden/hub-react',
              replacement: fileURLToPath(new URL('./packages/hub-react/src/index.ts', import.meta.url)),
            },
          ],
        },
        test: {
          name: 'hub-element',
          environment: 'jsdom',
          include: ['packages/hub-element/test/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          setupFiles: ['./packages/hub-element/test/setup.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});

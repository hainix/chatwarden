import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { withoutObscenityWordList } from './vite/withoutObscenityWordList';

// The site is a static bundle for Cloudflare Pages. Nothing here loads from a third party.
export default defineConfig({
  plugins: [react(), withoutObscenityWordList()],
  // The demo chunk carries the real hub, the staff routes and the player components (about 600 KB raw, 180 KB gzip). It is lazy: the
  // first load is the page alone (test/dist.test.ts holds both budgets), so Vite's 500 KB "large chunk" notice is raised to match.
  build: { outDir: 'dist', sourcemap: false, target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 700 },
});

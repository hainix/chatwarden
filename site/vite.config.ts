import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The site is a static bundle for Cloudflare Pages. Nothing here loads from a third party.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, target: 'es2022', assetsInlineLimit: 0 },
});

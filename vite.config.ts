import { crx } from '@crxjs/vite-plugin';
import { defineConfig } from 'vite';

import manifest from './src/manifest';

export default defineConfig({
  plugins: [crx({ manifest })],
  publicDir: false,
  server: {
    cors: {
      origin: [/chrome-extension:\/\//]
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false
  }
});

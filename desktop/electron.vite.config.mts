import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildCsp } from './src/shared/csp.ts';

/** Injects the CSP <meta> tag into every HTML entry (dev or prod variant). */
function cspMetaPlugin(): Plugin {
  let mode: 'development' | 'production' = 'production';
  return {
    name: 'signflow-csp-meta',
    configResolved(config) {
      mode = config.command === 'serve' ? 'development' : 'production';
    },
    transformIndexHtml(html) {
      return html.replace(
        '<!-- CSP -->',
        `<meta http-equiv="Content-Security-Policy" content="${buildCsp(mode, { meta: true })}" />`,
      );
    },
  };
}

const root = import.meta.dirname;
const shared = { '@shared': resolve(root, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          // Kokoro local voice, run in an Electron utilityProcess (see src/main/kokoro).
          kokoroWorker: resolve(root, 'src/main/kokoro/worker.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: shared },
  },
  renderer: {
    resolve: {
      alias: { ...shared, '@renderer': resolve(root, 'src/renderer/src') },
    },
    plugins: [react(), cspMetaPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'src/renderer/index.html'),
          captions: resolve(root, 'src/renderer/captions.html'),
        },
      },
    },
  },
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import { parseFrontendEnv } from './src/platform/env/parse-env.ts';
import { renderCloudflareHeaders } from './src/platform/security/document-csp.ts';

function cloudflareHeadersPlugin(): Plugin {
  return {
    name: 'roomies-cloudflare-headers',
    apply: 'build',
    async closeBundle() {
      let apiOrigin: string | undefined;
      try {
        apiOrigin = parseFrontendEnv(
          { VITE_API_ORIGIN: process.env['VITE_API_ORIGIN'] },
          { isDevelopment: false },
        ).apiOrigin;
      } catch {
        apiOrigin = undefined;
      }
      if (process.env['CI'] === 'true' && apiOrigin === undefined) {
        throw new Error(
          'VITE_API_ORIGIN is required for production frontend builds in CI',
        );
      }
      await writeFile(
        resolve('dist/_headers'),
        renderCloudflareHeaders({ apiOrigin }),
        'utf8',
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflareHeadersPlugin()],
  build: {
    // Do not ship source maps to the public frontend origin.
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**', '**/*.e2e.*'],
  },
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import {
  FrontendEnvError,
  parseFrontendEnv,
} from './src/platform/env/parse-env.ts';
import { renderCloudflareHeaders } from './src/platform/security/document-csp.ts';

function cloudflareHeadersPlugin(): Plugin {
  return {
    name: 'roomies-cloudflare-headers',
    apply: 'build',
    async closeBundle() {
      let apiOrigin: string | undefined;
      let r2S3Origin: string | undefined;
      try {
        const env = parseFrontendEnv(
          {
            VITE_API_ORIGIN: process.env['VITE_API_ORIGIN'],
            VITE_R2_S3_ORIGIN: process.env['VITE_R2_S3_ORIGIN'],
          },
          { isDevelopment: false },
        );
        apiOrigin = env.apiOrigin;
        r2S3Origin = env.r2S3Origin;
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        const r2Invalid =
          err instanceof FrontendEnvError &&
          message.includes('VITE_R2_S3_ORIGIN');
        if (r2Invalid || process.env['CI'] === 'true') {
          throw err instanceof Error
            ? err
            : new Error(
                'VITE_API_ORIGIN is required for production frontend builds in CI',
              );
        }
      }
      if (process.env['CI'] === 'true' && apiOrigin === undefined) {
        throw new Error(
          'VITE_API_ORIGIN is required for production frontend builds in CI',
        );
      }
      await writeFile(
        resolve('dist/_headers'),
        renderCloudflareHeaders({ apiOrigin, r2S3Origin }),
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

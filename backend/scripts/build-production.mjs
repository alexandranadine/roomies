#!/usr/bin/env node
/**
 * Compile the production backend entrypoint to backend/dist/main.js.
 *
 * Bundles Roomies source plus the isolated auth-runtime (Better Auth is not a
 * backend workspace dependency). Leaves process-native packages external so
 * Railway `npm ci` supplies them. Does not connect to a database and does not
 * run migrations.
 */

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

await rm(path.join(backendRoot, 'dist'), { recursive: true, force: true });

await build({
  absWorkingDir: backendRoot,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'info',
  sourcemap: false,
  legalComments: 'none',
  external: [
    'pg',
    'pg-native',
    'express',
    'cors',
    'helmet',
    'dotenv',
    'zod',
    '@prisma/orm-postgres',
    '@prisma/orm-postgres/runtime',
    '@js-temporal/polyfill',
    'sharp',
    '@img/*',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
});

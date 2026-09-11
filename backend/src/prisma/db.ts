import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from './contract.js';
import contractJson from './contract.json' with { type: 'json' };

const prismaDir = fileURLToPath(new URL('.', import.meta.url));
const backendRoot = resolve(prismaDir, '../..');

loadEnv({ path: resolve(backendRoot, '../.env'), quiet: true });
loadEnv({ path: resolve(backendRoot, '.env'), override: true, quiet: true });

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to construct the Prisma client');
}

export const db = postgres<Contract>({
  contractJson,
  url: databaseUrl,
});

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { definePrismaConfig } from 'prisma/config';
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config';

const backendRoot = fileURLToPath(new URL('.', import.meta.url));

// Prefer the monorepo-root `.env` (see root `.env.example`); allow a local override.
loadEnv({ path: resolve(backendRoot, '../.env'), quiet: true });
loadEnv({ path: resolve(backendRoot, '.env'), override: true, quiet: true });

const prismaCliDatabaseUrl =
  process.env['MIGRATION_DATABASE_URL']?.trim() ||
  process.env['DATABASE_URL'] ||
  '';

export default definePrismaConfig({
  skills: {
    // Agent skills are optional for this monorepo; disable the CLI staleness nudge.
    agents: [],
    check: false,
  },
  orm: ormConfig({
    contract: './src/prisma/contract.prisma',
    db: {
      // Release migrate sets MIGRATION_DATABASE_URL (Neon direct). Local/CI use DATABASE_URL.
      connection: prismaCliDatabaseUrl,
    },
  }),
});

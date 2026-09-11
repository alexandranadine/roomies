import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const configDir = fileURLToPath(new URL('.', import.meta.url));
const backendRoot = resolve(configDir, '../../..');
const monorepoRoot = resolve(backendRoot, '..');

let loaded = false;

/**
 * Load `.env` files for the application runtime process exactly once.
 *
 * Prefer monorepo-root `.env` (see root `.env.example`); allow `backend/.env` override.
 * Prisma CLI loading stays in `prisma.config.ts` and is separate from this path.
 */
export function loadRuntimeEnvFiles(): void {
  if (loaded) {
    return;
  }
  loadEnv({ path: resolve(monorepoRoot, '.env'), quiet: true });
  loadEnv({ path: resolve(backendRoot, '.env'), override: true, quiet: true });
  loaded = true;
}

/** Test-only: allow re-loading after env file changes in isolated suites. */
export function resetRuntimeEnvLoadForTests(): void {
  loaded = false;
}

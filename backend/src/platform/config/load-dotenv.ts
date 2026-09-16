import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

/**
 * Locate `@roomies/backend` whether this module is loaded from
 * `src/platform/config` (tsx) or from the production `dist/main.js` bundle.
 */
export function findBackendRoot(startDir: string): string {
  let current = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    const packageJsonPath = resolve(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
          name?: string;
        };
        if (pkg.name === '@roomies/backend') {
          return current;
        }
      } catch {
        // Unreadable package.json — keep walking.
      }
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolve(startDir, '../../..');
}

const configDir = fileURLToPath(new URL('.', import.meta.url));
const backendRoot = findBackendRoot(configDir);
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

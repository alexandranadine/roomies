import {
  createAuthRuntime as createIsolatedAuthRuntime,
  type AuthRuntime,
} from '../../../auth-runtime/src/index.js';

export type { AuthRuntime };
import type { Pool } from 'pg';
import type { AppConfig } from '../config/index.js';

/**
 * Backend-facing composition boundary for the isolated Better Auth package.
 * Product/domain modules must depend on this boundary, not Better Auth.
 */
export function createAuthRuntime(pool: Pool, config: AppConfig): AuthRuntime {
  return createIsolatedAuthRuntime({
    pool,
    baseURL: config.authBaseUrl,
    trustedOrigins: config.trustedOrigins,
    secret: config.authSecret,
    secureCookies: config.secureAuthCookies,
    log(level) {
      if (level === 'error') {
        console.error('[auth] runtime error');
      } else if (level === 'warn') {
        console.warn('[auth] runtime warning');
      }
    },
  });
}

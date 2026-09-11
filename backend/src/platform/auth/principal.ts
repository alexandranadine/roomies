import type { IncomingHttpHeaders } from 'node:http';
import type { Pool } from 'pg';
import {
  getAuthSessionFromNodeHeaders,
  type AuthRuntime,
} from '../../../auth-runtime/src/index.js';
import { AuthInfrastructureError, UnauthenticatedError } from './errors.js';

/**
 * Roomies-owned authenticated identity. Contains no Home, Membership, role,
 * or capability data. Authenticated is not authorized.
 */
export type AuthenticatedPrincipal = {
  userId: string;
};

export type ResolvePrincipalHeaders = {
  headers: IncomingHttpHeaders;
};

export type PrincipalResolver = {
  resolvePrincipal(
    request: ResolvePrincipalHeaders,
  ): Promise<AuthenticatedPrincipal | null>;
  requirePrincipal(
    request: ResolvePrincipalHeaders,
  ): Promise<AuthenticatedPrincipal>;
};

export type CanonicalUserLookup = (userId: string) => Promise<boolean>;

/**
 * Existence check for the canonical User row. Does not create or repair
 * users. Queries `users` only — never memberships or homes.
 */
export function createCanonicalUserLookup(pool: Pool): CanonicalUserLookup {
  return async (userId) => {
    const result = await pool.query(
      'SELECT 1 FROM users WHERE id = $1 LIMIT 1',
      [userId],
    );
    return result.rowCount === 1;
  };
}

export type CreatePrincipalResolverOptions = {
  auth: AuthRuntime;
  hasCanonicalUser: CanonicalUserLookup;
};

function logPrincipalFailure(kind: 'session' | 'integrity' | 'lookup'): void {
  console.error('[auth] principal resolution failed', {
    routeCategory: 'auth',
    errorClass: kind,
  });
}

/**
 * Resolve Better Auth's official session to a Roomies userId, then enforce
 * the canonical User invariant. Missing/invalid sessions are unauthenticated.
 */
export function createPrincipalResolver(
  options: CreatePrincipalResolverOptions,
): PrincipalResolver {
  const { auth, hasCanonicalUser } = options;

  async function resolvePrincipal(
    request: ResolvePrincipalHeaders,
  ): Promise<AuthenticatedPrincipal | null> {
    let session: Awaited<ReturnType<typeof getAuthSessionFromNodeHeaders>>;
    try {
      session = await getAuthSessionFromNodeHeaders(auth, request.headers);
    } catch {
      logPrincipalFailure('session');
      throw new AuthInfrastructureError();
    }

    const userId = session?.user?.id;
    if (typeof userId !== 'string' || userId.length === 0) {
      return null;
    }

    let exists: boolean;
    try {
      exists = await hasCanonicalUser(userId);
    } catch {
      logPrincipalFailure('lookup');
      throw new AuthInfrastructureError();
    }

    if (!exists) {
      logPrincipalFailure('integrity');
      throw new AuthInfrastructureError();
    }

    return { userId };
  }

  return {
    resolvePrincipal,
    async requirePrincipal(request) {
      const principal = await resolvePrincipal(request);
      if (principal === null) {
        throw new UnauthenticatedError();
      }
      return principal;
    },
  };
}

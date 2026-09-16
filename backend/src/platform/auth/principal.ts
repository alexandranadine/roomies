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
 *
 * `sessionCreatedAt` is authoritative Better Auth `session.session.createdAt`
 * from this same resolution. It is not an authorization input.
 */
export type AuthenticatedPrincipal = {
  userId: string;
  sessionCreatedAt?: Date;
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

export type CanonicalUserPresence = 'active' | 'deleted' | 'missing';

export type CanonicalUserLookup = (
  userId: string,
) => Promise<CanonicalUserPresence>;

/**
 * Canonical User presence for principal resolution. Does not create or repair
 * users. Queries `users` only — never memberships or homes.
 *
 * A row with `deleted_at` set is `deleted`, not missing. Missing remains an
 * integrity failure; deleted is unauthenticated.
 */
export function createCanonicalUserLookup(pool: Pool): CanonicalUserLookup {
  return async (userId) => {
    const result = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM users WHERE id = $1 LIMIT 1',
      [userId],
    );
    if (result.rowCount !== 1) {
      return 'missing';
    }
    return result.rows[0]?.deleted_at == null ? 'active' : 'deleted';
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

    let presence: CanonicalUserPresence;
    try {
      presence = await hasCanonicalUser(userId);
    } catch {
      logPrincipalFailure('lookup');
      throw new AuthInfrastructureError();
    }

    if (presence === 'deleted') {
      return null;
    }

    if (presence !== 'active') {
      logPrincipalFailure('integrity');
      throw new AuthInfrastructureError();
    }

    const sessionCreatedAt = readSessionCreatedAt(session);
    return sessionCreatedAt === undefined
      ? { userId }
      : { userId, sessionCreatedAt };
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

/**
 * Authoritative Better Auth session.session.createdAt only. Does not read
 * updatedAt, expiresAt, cookie age, or any client-supplied timestamp.
 */
export function readSessionCreatedAt(session: unknown): Date | undefined {
  if (typeof session !== 'object' || session === null) {
    return undefined;
  }
  if (!('session' in session)) {
    return undefined;
  }
  const nested = session.session;
  if (typeof nested !== 'object' || nested === null) {
    return undefined;
  }
  if (!('createdAt' in nested)) {
    return undefined;
  }
  const createdAt = nested.createdAt;
  if (createdAt instanceof Date && !Number.isNaN(createdAt.getTime())) {
    return createdAt;
  }
  if (typeof createdAt === 'string' || typeof createdAt === 'number') {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return undefined;
}

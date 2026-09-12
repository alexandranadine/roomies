import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import type { Pool } from 'pg';
import {
  InvalidNormalizedEmailError,
  normalizeEmail,
} from './normalized-email.js';

const SEVEN_DAYS_SECONDS = 60 * 60 * 24 * 7;
const ONE_DAY_SECONDS = 60 * 60 * 24;

function invalidEmail(): APIError {
  return new APIError('BAD_REQUEST', {
    code: 'INVALID_EMAIL',
    message: 'Invalid email address',
  });
}

function normalizeAuthEmail(value: string): string {
  try {
    return normalizeEmail(value);
  } catch (error) {
    if (error instanceof InvalidNormalizedEmailError) {
      throw invalidEmail();
    }
    throw error;
  }
}

const normalizeEmailBeforeValidation = createAuthMiddleware((context) => {
  const body: unknown = context.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Promise.resolve();
  }
  const fields = body as Record<string, unknown>;
  if (
    context.path === '/sign-up/email' &&
    typeof fields['email'] === 'string'
  ) {
    fields['email'] = normalizeAuthEmail(fields['email']);
  }

  if (
    context.path === '/change-email' &&
    typeof fields['newEmail'] === 'string'
  ) {
    fields['newEmail'] = normalizeAuthEmail(fields['newEmail']);
  }
  return Promise.resolve();
});

export type AuthRuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type CreateAuthRuntimeOptions = Readonly<{
  /** Process-owned pool. This package never creates or closes it. */
  pool: Pool;
  baseURL: string;
  trustedOrigins: readonly string[];
  secret: string;
  secureCookies: boolean;
  /**
   * Content-free operational sink. Better Auth messages and metadata are not
   * forwarded because they may contain SQL or authentication material.
   */
  log?: (level: AuthRuntimeLogLevel) => void;
}>;

function createOptions(input: CreateAuthRuntimeOptions): BetterAuthOptions {
  return {
    appName: 'Roomies',
    baseURL: input.baseURL,
    secret: input.secret,
    trustedOrigins: [...input.trustedOrigins],
    database: input.pool,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    user: {
      modelName: 'auth_identities',
      fields: {
        name: 'name',
        email: 'email',
        emailVerified: 'email_verified',
        image: 'image',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        scope: 'scope',
        password: 'password',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
      },
    },
    session: {
      modelName: 'auth_sessions',
      fields: {
        expiresAt: 'expires_at',
        token: 'token',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
      expiresIn: SEVEN_DAYS_SECONDS,
      updateAge: ONE_DAY_SECONDS,
      cookieCache: {
        enabled: false,
      },
    },
    verification: {
      modelName: 'auth_verifications',
      fields: {
        identifier: 'identifier',
        value: 'value',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    hooks: {
      before: normalizeEmailBeforeValidation,
    },
    databaseHooks: {
      user: {
        create: {
          before(user) {
            return Promise.resolve({
              data: {
                ...user,
                email: normalizeAuthEmail(user.email),
              },
            });
          },
        },
        update: {
          before(user) {
            if (typeof user.email !== 'string') {
              return Promise.resolve();
            }
            return Promise.resolve({
              data: {
                ...user,
                email: normalizeAuthEmail(user.email),
              },
            });
          },
        },
      },
    },
    advanced: {
      database: {
        generateId: 'uuid',
        validateSchema: true,
      },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: input.secureCookies,
        sameSite: 'lax',
      },
      // Better Auth skips origin/CSRF when NODE_ENV=test unless this is set.
      disableOriginCheck: false,
    },
    plugins: [],
    logger: {
      level: 'warn',
      disableColors: true,
      log(level) {
        if (level === 'warn' || level === 'error') {
          input.log?.(level);
        }
      },
    },
  };
}

/**
 * Create Better Auth around infrastructure owned by the Roomies process.
 *
 * This initializes runtime configuration only. HTTP mounting lives in the
 * Roomies platform/auth boundary. There are deliberately no application
 * provisioning hooks: PostgreSQL's accepted trigger remains the sole
 * canonical User provisioning mechanism. The user hooks only enforce the
 * canonical email representation immediately before identity persistence.
 */
export function createAuthRuntime(input: CreateAuthRuntimeOptions) {
  return betterAuth(createOptions(input));
}

export type AuthRuntime = ReturnType<typeof createAuthRuntime>;

export {
  InvalidNormalizedEmailError,
  normalizeEmail,
  type NormalizedEmail,
} from './normalized-email.js';

/**
 * Official Better Auth Node/Express adapter. Callers must mount this before
 * Express JSON body parsing so Better Auth can read the native request body.
 */
export function createAuthNodeHandler(auth: AuthRuntime) {
  return toNodeHandler(auth);
}

/**
 * Official session lookup from Node incoming headers.
 * Returns Better Auth's session payload; Roomies principal mapping stays
 * outside this package.
 */
export function getAuthSessionFromNodeHeaders(
  auth: AuthRuntime,
  headers: IncomingHttpHeaders,
) {
  return auth.api.getSession({
    headers: fromNodeHeaders(headers),
  });
}

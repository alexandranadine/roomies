import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { Pool } from 'pg';

const SEVEN_DAYS_SECONDS = 60 * 60 * 24 * 7;
const ONE_DAY_SECONDS = 60 * 60 * 24;

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
 * This initializes runtime configuration only. Route mounting belongs to
 * M1.3c. There are deliberately no application database hooks: PostgreSQL's
 * accepted trigger is the sole canonical User provisioning mechanism.
 */
export function createAuthRuntime(input: CreateAuthRuntimeOptions) {
  return betterAuth(createOptions(input));
}

export type AuthRuntime = ReturnType<typeof createAuthRuntime>;

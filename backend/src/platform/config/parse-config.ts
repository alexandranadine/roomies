import { z } from 'zod';
import { ConfigError, SECRET_ENV_KEYS } from './errors.js';
import {
  normalizeTrustedOrigin,
  parseTrustedOriginsList,
} from './normalize-origin.js';
import { loadRuntimeEnvFiles } from './load-dotenv.js';
import { APP_ENVS, type AppConfig, type AppEnv } from './types.js';

/** Default Vite-style local frontend origins (development / test only). */
const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

const DEFAULT_PORT = 3000;
const LOCAL_AUTH_BASE_URL = 'http://localhost:3000';
const LOCAL_DEFAULT_FRONTEND_ORIGIN = 'http://localhost:5173';
const INSECURE_AUTH_SECRETS = new Set([
  'better-auth-secret-123456789',
  'replace_with_a_random_secret_of_at_least_32_characters',
]);
/** Direct-facing default: do not trust forwarded headers. */
const DEFAULT_TRUST_PROXY_HOPS = 0;
/** Upper bound for hop count (guards against absurd/mis-typed values). */
const MAX_TRUST_PROXY_HOPS = 32;

function estimatedSecretEntropy(value: string): number {
  const uniqueCharacters = new Set(value).size;
  return uniqueCharacters === 0
    ? 0
    : value.length * Math.log2(uniqueCharacters);
}

export type ConfigSource = Readonly<Record<string, string | undefined>>;

function isLocalDefaultEnv(appEnv: AppEnv): boolean {
  return appEnv === 'development' || appEnv === 'test';
}

const portSchema = z
  .string()
  .trim()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw === '') {
      return DEFAULT_PORT;
    }
    if (!/^\d+$/.test(raw)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'PORT must be an integer between 1 and 65535 (received a non-integer value)',
      });
      return z.NEVER;
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.addIssue({
        code: 'custom',
        message: 'PORT must be an integer between 1 and 65535',
      });
      return z.NEVER;
    }
    return port;
  });

const trustProxySchema = z
  .string()
  .trim()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw === '') {
      return DEFAULT_TRUST_PROXY_HOPS;
    }
    const normalized = raw.toLowerCase();
    if (normalized === 'true' || normalized === 'false') {
      ctx.addIssue({
        code: 'custom',
        message:
          'TRUST_PROXY must be a non-negative integer hop count (boolean true/false is not allowed)',
      });
      return z.NEVER;
    }
    if (!/^\d+$/.test(raw)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'TRUST_PROXY must be a non-negative integer hop count (received a non-integer value)',
      });
      return z.NEVER;
    }
    const hops = Number(raw);
    if (!Number.isInteger(hops) || hops < 0 || hops > MAX_TRUST_PROXY_HOPS) {
      ctx.addIssue({
        code: 'custom',
        message: `TRUST_PROXY must be an integer between 0 and ${MAX_TRUST_PROXY_HOPS}`,
      });
      return z.NEVER;
    }
    return hops;
  });

const envSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVS, {
      error: () =>
        `APP_ENV must be one of: ${APP_ENVS.join(', ')} (received an unrecognized value)`,
    }),
    PORT: portSchema,
    DATABASE_URL: z
      .string({
        error: () => 'DATABASE_URL is required',
      })
      .trim()
      .min(1, { error: 'DATABASE_URL is required' }),
    AUTH_BASE_URL: z.string().optional(),
    AUTH_SECRET: z
      .string({
        error: () => 'AUTH_SECRET is required',
      })
      .min(32, { error: 'AUTH_SECRET must be at least 32 characters' })
      .refine((value) => !INSECURE_AUTH_SECRETS.has(value), {
        error: 'AUTH_SECRET must not use a documented placeholder or default',
      })
      .refine((value) => estimatedSecretEntropy(value) >= 120, {
        error: 'AUTH_SECRET must be a high-entropy random value',
      }),
    TRUSTED_ORIGINS: z.string().optional(),
    FRONTEND_ORIGIN: z.string().optional(),
    TRUST_PROXY: trustProxySchema,
  })
  .transform((data, ctx) => {
    const appEnv = data.APP_ENV;
    const rawOrigins = data.TRUSTED_ORIGINS?.trim();
    const rawAuthBaseUrl = data.AUTH_BASE_URL?.trim();
    const rawFrontendOrigin = data.FRONTEND_ORIGIN?.trim();

    let trustedOrigins: string[];
    if (rawOrigins === undefined || rawOrigins === '') {
      if (isLocalDefaultEnv(appEnv)) {
        trustedOrigins = [...LOCAL_DEV_ORIGINS];
      } else {
        ctx.addIssue({
          code: 'custom',
          path: ['TRUSTED_ORIGINS'],
          message: `TRUSTED_ORIGINS is required when APP_ENV=${appEnv}`,
        });
        return z.NEVER;
      }
    } else {
      try {
        trustedOrigins = parseTrustedOriginsList(rawOrigins);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid value';
        ctx.addIssue({
          code: 'custom',
          path: ['TRUSTED_ORIGINS'],
          message: `TRUSTED_ORIGINS is invalid: ${detail}`,
        });
        return z.NEVER;
      }
    }

    let authBaseUrl: string;
    if (rawAuthBaseUrl === undefined || rawAuthBaseUrl === '') {
      if (isLocalDefaultEnv(appEnv)) {
        authBaseUrl = LOCAL_AUTH_BASE_URL;
      } else {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_BASE_URL'],
          message: `AUTH_BASE_URL is required when APP_ENV=${appEnv}`,
        });
        return z.NEVER;
      }
    } else {
      try {
        authBaseUrl = normalizeTrustedOrigin(rawAuthBaseUrl);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid value';
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_BASE_URL'],
          message: `AUTH_BASE_URL is invalid: ${detail}`,
        });
        return z.NEVER;
      }
    }

    let frontendOrigin: string;
    if (rawFrontendOrigin === undefined || rawFrontendOrigin === '') {
      if (isLocalDefaultEnv(appEnv)) {
        frontendOrigin = LOCAL_DEFAULT_FRONTEND_ORIGIN;
      } else {
        ctx.addIssue({
          code: 'custom',
          path: ['FRONTEND_ORIGIN'],
          message: `FRONTEND_ORIGIN is required when APP_ENV=${appEnv}`,
        });
        return z.NEVER;
      }
    } else {
      try {
        frontendOrigin = normalizeTrustedOrigin(rawFrontendOrigin);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid value';
        ctx.addIssue({
          code: 'custom',
          path: ['FRONTEND_ORIGIN'],
          message: `FRONTEND_ORIGIN is invalid: ${detail}`,
        });
        return z.NEVER;
      }
    }

    return {
      appEnv,
      port: data.PORT,
      databaseUrl: data.DATABASE_URL,
      authBaseUrl,
      authSecret: data.AUTH_SECRET,
      secureAuthCookies: !isLocalDefaultEnv(appEnv),
      frontendOrigin,
      trustedOrigins,
      trustProxyHops: data.TRUST_PROXY,
    } satisfies {
      appEnv: AppEnv;
      port: number;
      databaseUrl: string;
      authBaseUrl: string;
      authSecret: string;
      secureAuthCookies: boolean;
      frontendOrigin: string;
      trustedOrigins: string[];
      trustProxyHops: number;
    };
  });

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value;
}

/**
 * Map Zod issues to human-readable lines that never include secret values.
 * DATABASE_URL failures are reduced to the variable name only.
 */
function formatIssues(zodError: z.ZodError): string[] {
  const issues: string[] = [];

  for (const issue of zodError.issues) {
    const key = String(issue.path[0] ?? '');
    if (key === 'DATABASE_URL') {
      issues.push('DATABASE_URL is required');
      continue;
    }
    if (key === 'AUTH_SECRET') {
      issues.push(issue.message);
      continue;
    }
    if (key === 'APP_ENV' && issue.code === 'invalid_type') {
      issues.push('APP_ENV is required');
      continue;
    }
    if (key === 'APP_ENV') {
      issues.push(
        issue.message.startsWith('APP_ENV')
          ? issue.message
          : `APP_ENV must be one of: ${APP_ENVS.join(', ')} (received an unrecognized value)`,
      );
      continue;
    }
    if (key === 'PORT') {
      issues.push(
        issue.message.startsWith('PORT')
          ? issue.message
          : 'PORT must be an integer between 1 and 65535',
      );
      continue;
    }
    if (key === 'TRUSTED_ORIGINS' || key === 'FRONTEND_ORIGIN') {
      issues.push(issue.message);
      continue;
    }
    if (key === 'AUTH_BASE_URL') {
      issues.push(issue.message);
      continue;
    }
    if (key === 'TRUST_PROXY') {
      issues.push(
        issue.message.startsWith('TRUST_PROXY')
          ? issue.message
          : 'TRUST_PROXY must be a non-negative integer hop count',
      );
      continue;
    }
    // Fallback: keep message but never echo unknown received blobs for secrets.
    issues.push(issue.message);
  }

  return [...new Set(issues)];
}

/**
 * Parse configuration from an explicit env-like record.
 * Pure: does not read `process.env` or load dotenv files.
 */
export function parseConfig(source: ConfigSource): AppConfig {
  const result = envSchema.safeParse({
    APP_ENV: optionalString(source['APP_ENV']),
    PORT: optionalString(source['PORT']),
    DATABASE_URL: optionalString(source['DATABASE_URL']),
    AUTH_BASE_URL: optionalString(source['AUTH_BASE_URL']),
    AUTH_SECRET: optionalString(source['AUTH_SECRET']),
    TRUSTED_ORIGINS: optionalString(source['TRUSTED_ORIGINS']),
    FRONTEND_ORIGIN: optionalString(source['FRONTEND_ORIGIN']),
    TRUST_PROXY: optionalString(source['TRUST_PROXY']),
  });

  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new ConfigError(
      `Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
      issues,
    );
  }

  return Object.freeze({
    appEnv: result.data.appEnv,
    port: result.data.port,
    databaseUrl: result.data.databaseUrl,
    authBaseUrl: result.data.authBaseUrl,
    authSecret: result.data.authSecret,
    secureAuthCookies: result.data.secureAuthCookies,
    frontendOrigin: result.data.frontendOrigin,
    trustedOrigins: Object.freeze([...result.data.trustedOrigins]),
    trustProxyHops: result.data.trustProxyHops,
  });
}

/**
 * Load dotenv once (if needed), then parse `process.env`.
 * Call this at process startup; pass the result into the rest of the backend.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { loadDotenv?: boolean } = {},
): AppConfig {
  if (options.loadDotenv !== false) {
    loadRuntimeEnvFiles();
  }
  return parseConfig(env);
}

/** Redact secret values from an arbitrary string (defensive for logging). */
export function redactSecrets(
  text: string,
  source: ConfigSource = process.env,
): string {
  let result = text;
  for (const key of SECRET_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value.length > 0) {
      result = result.split(value).join(`[redacted:${key}]`);
    }
  }
  return result;
}

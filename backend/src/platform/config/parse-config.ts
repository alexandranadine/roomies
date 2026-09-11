import { z } from 'zod';
import { ConfigError, SECRET_ENV_KEYS } from './errors.js';
import { parseTrustedOriginsList } from './normalize-origin.js';
import { loadRuntimeEnvFiles } from './load-dotenv.js';
import { APP_ENVS, type AppConfig, type AppEnv } from './types.js';

/** Default Vite-style local frontend origins (development / test only). */
const LOCAL_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

const DEFAULT_PORT = 3000;

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
    TRUSTED_ORIGINS: z.string().optional(),
  })
  .transform((data, ctx) => {
    const appEnv = data.APP_ENV;
    const rawOrigins = data.TRUSTED_ORIGINS?.trim();

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

    return {
      appEnv,
      port: data.PORT,
      databaseUrl: data.DATABASE_URL,
      trustedOrigins,
    } satisfies {
      appEnv: AppEnv;
      port: number;
      databaseUrl: string;
      trustedOrigins: string[];
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
    if (key === 'DATABASE_URL' || SECRET_ENV_KEYS.has(key)) {
      issues.push('DATABASE_URL is required');
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
    if (key === 'TRUSTED_ORIGINS') {
      issues.push(issue.message);
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
    TRUSTED_ORIGINS: optionalString(source['TRUSTED_ORIGINS']),
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
    trustedOrigins: Object.freeze([...result.data.trustedOrigins]),
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

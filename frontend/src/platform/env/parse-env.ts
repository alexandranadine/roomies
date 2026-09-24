import { z } from 'zod';
import {
  normalizeApiOrigin,
  normalizePublicOrigin,
} from './normalize-api-origin.js';

/** Local backend default — development / Vitest only. Never used for deployed builds. */
export const DEV_DEFAULT_API_ORIGIN = 'http://localhost:3000';

export type FrontendEnv = {
  /** Canonical API origin (scheme://host[:port]), no trailing path. */
  apiOrigin: string;
  /**
   * Canonical public R2 S3 origin (scheme://host[:port]) for `connect-src`
   * and browser object transfer. Omitted when unset.
   */
  r2S3Origin?: string;
};

export type FrontendEnvSource = Readonly<{
  VITE_API_ORIGIN?: string | undefined;
  VITE_R2_S3_ORIGIN?: string | undefined;
}>;

export type ParseFrontendEnvOptions = {
  /**
   * When true, missing/empty `VITE_API_ORIGIN` falls back to the local backend.
   * Must be false for production / deployed builds.
   */
  isDevelopment: boolean;
};

export class FrontendEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontendEnvError';
  }
}

const rawOriginSchema = z.string().optional();

function parseOptionalR2S3Origin(raw: string | undefined): string | undefined {
  const rawResult = rawOriginSchema.safeParse(raw);
  if (!rawResult.success) {
    throw new FrontendEnvError('VITE_R2_S3_ORIGIN is invalid');
  }

  const trimmed = rawResult.data?.trim() ?? '';
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    return normalizePublicOrigin(trimmed, 'VITE_R2_S3_ORIGIN');
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'invalid R2 S3 origin';
    throw new FrontendEnvError(`VITE_R2_S3_ORIGIN: ${detail}`);
  }
}

/**
 * Validate public frontend environment.
 *
 * Only `VITE_API_ORIGIN` and optional `VITE_R2_S3_ORIGIN` are supported.
 * Secrets (e.g. `DATABASE_URL`, `R2_ACCESS_KEY_ID`) must never be placed in
 * Vite env — they would be embedded in the client bundle.
 */
export function parseFrontendEnv(
  source: FrontendEnvSource,
  options: ParseFrontendEnvOptions,
): FrontendEnv {
  const rawResult = rawOriginSchema.safeParse(source.VITE_API_ORIGIN);
  if (!rawResult.success) {
    throw new FrontendEnvError('VITE_API_ORIGIN is invalid');
  }

  const raw = rawResult.data?.trim() ?? '';
  let apiOrigin: string;

  if (raw.length === 0) {
    if (options.isDevelopment) {
      apiOrigin = DEV_DEFAULT_API_ORIGIN;
    } else {
      throw new FrontendEnvError(
        'VITE_API_ORIGIN is required for deployed builds (no localhost default)',
      );
    }
  } else {
    try {
      apiOrigin = normalizeApiOrigin(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'invalid API origin';
      throw new FrontendEnvError(`VITE_API_ORIGIN: ${detail}`);
    }
  }

  const r2S3Origin = parseOptionalR2S3Origin(source.VITE_R2_S3_ORIGIN);
  if (r2S3Origin === undefined) {
    return { apiOrigin };
  }
  return { apiOrigin, r2S3Origin };
}

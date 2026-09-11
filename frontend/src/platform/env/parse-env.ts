import { z } from 'zod';
import { normalizeApiOrigin } from './normalize-api-origin.js';

/** Local backend default — development / Vitest only. Never used for deployed builds. */
export const DEV_DEFAULT_API_ORIGIN = 'http://localhost:3000';

export type FrontendEnv = {
  /** Canonical API origin (scheme://host[:port]), no trailing path. */
  apiOrigin: string;
};

export type FrontendEnvSource = Readonly<{
  VITE_API_ORIGIN?: string | undefined;
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

/**
 * Validate public frontend environment.
 *
 * Only `VITE_API_ORIGIN` is supported. Secrets (e.g. `DATABASE_URL`) must never
 * be placed in Vite env — they would be embedded in the client bundle.
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

  if (raw.length === 0) {
    if (options.isDevelopment) {
      return { apiOrigin: DEV_DEFAULT_API_ORIGIN };
    }
    throw new FrontendEnvError(
      'VITE_API_ORIGIN is required for deployed builds (no localhost default)',
    );
  }

  try {
    return { apiOrigin: normalizeApiOrigin(raw) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'invalid API origin';
    throw new FrontendEnvError(`VITE_API_ORIGIN: ${detail}`);
  }
}

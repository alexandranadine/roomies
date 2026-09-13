export const APP_ENVS = [
  'development',
  'test',
  'preview',
  'staging',
  'production',
] as const;

export type AppEnv = (typeof APP_ENVS)[number];

export const PROCESS_MODES = ['web', 'worker', 'combined'] as const;

export type ProcessMode = (typeof PROCESS_MODES)[number];

/** Initial Railway deployment and local default: one process serves HTTP and polls. */
export const DEFAULT_PROCESS_MODE: ProcessMode = 'combined';

export const DEFAULT_RECURRENCE_POLL_INTERVAL_MS = 30_000;
export const MIN_RECURRENCE_POLL_INTERVAL_MS = 1_000;
export const MAX_RECURRENCE_POLL_INTERVAL_MS = 300_000;

export type ProcessRuntimeConfig = Readonly<{
  /**
   * Explicit process role. Never inferred from unrelated variables.
   * `combined` is the default and the initial production deployment.
   */
  processMode: ProcessMode;
  /** Recurrence polling sleep when no immediate due work remains. */
  recurrencePollIntervalMs: number;
}>;

/**
 * Immutable, typed application configuration.
 * Parsed once at process startup; modules consume this object, not `process.env`.
 */
export type AppConfig = Readonly<{
  appEnv: AppEnv;
  /** Backend HTTP listen port. */
  port: number;
  /** PostgreSQL connection string. Never log this value. */
  databaseUrl: string;
  /** Explicit public backend origin used by Better Auth callbacks and cookies. */
  authBaseUrl: string;
  /** Better Auth signing/encryption secret. Never log this value. */
  authSecret: string;
  /** Whether authentication cookies must carry the Secure attribute. */
  secureAuthCookies: boolean;
  /**
   * Canonical public frontend origin for invite URLs and other app links.
   * Normalized to scheme://host[:port] with no path, query, hash, or wildcards.
   */
  frontendOrigin: string;
  /**
   * Exact trusted frontend origins for the HTTP/CORS layer.
   * Normalized to scheme://host[:port] with no path, query, hash, or wildcards.
   */
  trustedOrigins: readonly string[];
  /**
   * Express `trust proxy` hop count.
   * `0` means do not trust `X-Forwarded-*` (direct client). Positive integers
   * trust that many proxy hops (right-to-left in `X-Forwarded-For`).
   * Never unrestricted `true`.
   */
  trustProxyHops: number;
}>;

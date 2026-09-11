export const APP_ENVS = [
  'development',
  'test',
  'preview',
  'staging',
  'production',
] as const;

export type AppEnv = (typeof APP_ENVS)[number];

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

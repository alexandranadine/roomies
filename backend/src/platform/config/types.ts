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
  /**
   * Exact trusted frontend origins for the upcoming HTTP/CORS layer.
   * Normalized to scheme://host[:port] with no path, query, hash, or wildcards.
   */
  trustedOrigins: readonly string[];
}>;

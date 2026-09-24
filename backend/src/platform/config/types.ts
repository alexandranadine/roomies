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

/**
 * How the HTTP process identifies the connecting client.
 * Never inferred from APP_ENV. Default is `direct`.
 */
export const INGRESS_MODES = ['direct', 'cloudflare'] as const;

export type IngressMode = (typeof INGRESS_MODES)[number];

export const DEFAULT_INGRESS_MODE: IngressMode = 'direct';

export type DirectIngressConfig = Readonly<{
  mode: 'direct';
}>;

export type CloudflareIngressConfig = Readonly<{
  mode: 'cloudflare';
  /**
   * Shared secret Cloudflare overwrites on `X-Roomies-Origin-Auth`.
   * Never log this value.
   */
  originAuthSecret: string;
}>;

export type IngressRuntimeConfig =
  DirectIngressConfig | CloudflareIngressConfig;

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

export const EMAIL_PROVIDERS = ['fake', 'resend'] as const;

export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export type FakeEmailConfig = Readonly<{
  provider: 'fake';
}>;

export type ResendEmailConfig = Readonly<{
  provider: 'resend';
  /** Resend API key. Never log this value. */
  apiKey: string;
  /** Verified From address (`email` or `Name <email>`). */
  from: string;
}>;

export type EmailRuntimeConfig = FakeEmailConfig | ResendEmailConfig;

export const OBJECT_STORE_PROVIDERS = ['fake', 'cloudflare'] as const;

export type ObjectStoreProvider = (typeof OBJECT_STORE_PROVIDERS)[number];

export type FakeObjectStoreConfig = Readonly<{
  provider: 'fake';
}>;

export type CloudflareObjectStoreConfig = Readonly<{
  provider: 'cloudflare';
  /** Cloudflare account id used to build the default S3 endpoint. */
  accountId: string;
  /** R2 access key id. Never log this value. */
  accessKeyId: string;
  /** R2 secret access key. Never log this value. */
  secretAccessKey: string;
  bucket: string;
  /** S3-compatible API endpoint. */
  s3Endpoint: string;
  /** S3 region. R2 uses `auto`. */
  region: string;
}>;

export type ObjectStoreRuntimeConfig =
  FakeObjectStoreConfig | CloudflareObjectStoreConfig;

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
  /**
   * Client network-identity source. `direct` uses Express `req.ip` under
   * `trustProxyHops`. `cloudflare` authenticates the overwritten origin-auth
   * header and then trusts a single `CF-Connecting-IP`. Omitted hand-built
   * test configs behave as `direct`.
   */
  ingress?: IngressRuntimeConfig;
  /**
   * Safe release identifier for health/readiness probes. Hex git SHA when set.
   * Never an environment dump or filesystem path.
   */
  releaseSha?: string;
  /**
   * Transactional auth-email adapter. Omitted only in tests that construct
   * AppConfig by hand; those default to the in-memory fake sender.
   */
  email?: EmailRuntimeConfig;
  /**
   * Private Home-photo object store. Omitted only in tests that construct
   * AppConfig by hand; those default to the in-memory fake store.
   */
  objectStore?: ObjectStoreRuntimeConfig;
}>;

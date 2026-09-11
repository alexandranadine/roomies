/**
 * Shared helpers for future real-PostgreSQL integration tests.
 *
 * Schema must come from reviewed migrations (`npm run db:test:migrate`), not
 * ad-hoc CREATE TABLE. Destructive helpers refuse non-test databases.
 */

export type TestDatabaseUrlOptions = {
  /**
   * Preferred source. Falls back to process.env.DATABASE_URL / TEST_DATABASE_URL.
   */
  url?: string;
  /**
   * Environment map (tests may inject a fake process.env).
   */
  env?: NodeJS.ProcessEnv;
};

const SAFE_DB_NAME =
  /^(?:roomies_test|roomies_ci|test_roomies|[a-z0-9_]*_test|[a-z0-9_]*_ci)$/i;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Resolve the URL used for integration / migration verification tests.
 * Prefer TEST_DATABASE_URL so local development DATABASE_URL is never required.
 */
export function resolveTestDatabaseUrl(
  options: TestDatabaseUrlOptions = {},
): string {
  const env = options.env ?? process.env;
  const raw = options.url ?? env['TEST_DATABASE_URL'] ?? env['DATABASE_URL'];
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      'Test database URL is missing. Set TEST_DATABASE_URL (preferred) or DATABASE_URL to a local test database.',
    );
  }
  return raw.trim();
}

export type ParsedDatabaseUrl = {
  protocol: string;
  hostname: string;
  port: string;
  database: string;
  hrefWithoutCredentials: string;
};

/**
 * Parse a PostgreSQL connection string without logging credentials.
 */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }

  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    throw new Error('Test database URL must use the postgresql: scheme');
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error('Test database URL must include a database name');
  }

  const safe = new URL(url);
  safe.username = '';
  safe.password = '';

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || '5432',
    database,
    hrefWithoutCredentials: safe.toString(),
  };
}

/**
 * Refuse URLs that look like production / shared / non-test databases.
 * Destructive cleanup and fresh-migrate reset must call this first.
 */
export function assertSafeTestDatabase(url: string): ParsedDatabaseUrl {
  const parsed = parseDatabaseUrl(url);
  const host = parsed.hostname.toLowerCase();
  const db = parsed.database;

  // Neon / managed production hostnames are never safe for destructive helpers.
  if (
    host.includes('neon.tech') ||
    host.includes('amazonaws.com') ||
    host.includes('railway.app') ||
    host.includes('supabase.co')
  ) {
    throw new Error(
      'Refusing managed/production-looking database host for destructive test helpers.',
    );
  }

  if (!LOCAL_HOSTS.has(host) && !host.endsWith('.local')) {
    // Allow GitHub Actions / Compose service hostnames that are clearly CI.
    const ciHosts = new Set(['postgres', 'roomies-postgres']);
    if (!ciHosts.has(host) && process.env['CI'] !== 'true') {
      throw new Error(
        `Refusing non-local test database host "${host}". Destructive test helpers only run against localhost / Compose / CI service hosts.`,
      );
    }
  }

  if (!SAFE_DB_NAME.test(db)) {
    throw new Error(
      `Refusing database name "${db}". Destructive helpers require a name matching *_test, *_ci, roomies_test, or roomies_ci.`,
    );
  }

  // Extra belt: production APP_ENV must never drive destructive helpers.
  const appEnv = (process.env['APP_ENV'] ?? '').toLowerCase();
  if (appEnv === 'production' || appEnv === 'staging') {
    throw new Error(
      `Refusing destructive database helpers while APP_ENV=${appEnv}.`,
    );
  }

  return parsed;
}

/**
 * Whether two workers can safely share the same logical database.
 * M0 keeps a single shared test DB; parallel suites should use transactions
 * or separate database names (future). Documented for callers.
 */
export function supportsParallelDestructiveReset(): boolean {
  return false;
}

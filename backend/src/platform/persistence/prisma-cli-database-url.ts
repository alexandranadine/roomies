/**
 * Prisma CLI connection selection. Application runtime never reads this helper.
 *
 * Neon (and other PgBouncer) pooled URLs are valid for the process-owned
 * `pg.Pool`. Prisma `db migrate` / `db verify` need a session-capable direct
 * connection. Release environments set `MIGRATION_DATABASE_URL` to that direct
 * URL; local/CI keep using `DATABASE_URL` alone.
 */
export function resolvePrismaCliDatabaseUrl(
  source: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const migrationUrl = source['MIGRATION_DATABASE_URL']?.trim();
  if (migrationUrl) {
    return migrationUrl;
  }
  const databaseUrl = source['DATABASE_URL']?.trim();
  if (databaseUrl) {
    return databaseUrl;
  }
  return undefined;
}

export function prismaCliDatabaseUrlMissingMessage(): string {
  return 'DATABASE_URL is required for Prisma CLI (or MIGRATION_DATABASE_URL for release migrate)';
}

import {
  normalizeEmail,
  type NormalizedEmail,
} from '../../../auth-runtime/src/index.js';
import { AuthInfrastructureError } from './errors.js';

export type CurrentCanonicalIdentity = Readonly<{
  userId: string;
  email: NormalizedEmail;
  emailVerified: boolean;
}>;

export type CurrentCanonicalIdentityQuery = Readonly<{
  query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}>;

type IdentityRow = {
  id: unknown;
  email: unknown;
  email_verified: unknown;
  has_user: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the current Better Auth-owned canonical identity for an authenticated
 * Roomies User. This is intentionally transaction-query compatible so callers
 * can revalidate identity after acquiring product structural locks.
 */
export async function findCurrentCanonicalIdentityByUser(
  database: CurrentCanonicalIdentityQuery,
  userId: string,
): Promise<CurrentCanonicalIdentity | null> {
  let rows: IdentityRow[];
  try {
    rows = (
      await database.query<IdentityRow>(
        `SELECT i.id, i.email, i.email_verified,
                EXISTS (SELECT 1 FROM users u WHERE u.id = i.id) AS has_user
         FROM auth_identities i
         WHERE i.id = $1::uuid
         LIMIT 2`,
        [userId],
      )
    ).rows;
  } catch {
    throw new AuthInfrastructureError();
  }

  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row === undefined ||
    typeof row.id !== 'string' ||
    !UUID_PATTERN.test(row.id) ||
    row.id !== userId ||
    typeof row.email !== 'string' ||
    typeof row.email_verified !== 'boolean' ||
    row.has_user !== true
  ) {
    throw new AuthInfrastructureError();
  }

  try {
    const email = normalizeEmail(row.email);
    if (email !== row.email) {
      throw new AuthInfrastructureError();
    }
    return Object.freeze({
      userId: row.id,
      email,
      emailVerified: row.email_verified,
    });
  } catch {
    throw new AuthInfrastructureError();
  }
}

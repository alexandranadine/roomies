import {
  normalizeEmail,
  type NormalizedEmail,
} from '../../../auth-runtime/src/index.js';
import { AuthInfrastructureError } from './errors.js';

export type CanonicalIdentity = Readonly<{
  userId: string;
  email: NormalizedEmail;
}>;

export type CanonicalIdentityQuery = Readonly<{
  query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}>;

export type CanonicalIdentityByEmailLookup = (
  email: NormalizedEmail,
) => Promise<CanonicalIdentity | null>;

type IdentityRow = {
  id: unknown;
  email: unknown;
  has_user: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a canonical User from the frozen normalized-email authority.
 * Unverified identities are visible. Ambiguous or noncanonical rows fail closed.
 */
export async function findCanonicalIdentityByEmail(
  database: CanonicalIdentityQuery,
  email: NormalizedEmail,
): Promise<CanonicalIdentity | null> {
  let rows: IdentityRow[];
  try {
    const result = await database.query<IdentityRow>(
      `SELECT i.id, i.email,
              EXISTS (SELECT 1 FROM users u WHERE u.id = i.id) AS has_user
       FROM auth_identities i
       WHERE i.email = $1::text
       LIMIT 2`,
      [email],
    );
    rows = result.rows;
  } catch {
    throw new AuthInfrastructureError();
  }

  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new AuthInfrastructureError();
  }

  const row = rows[0];
  if (
    typeof row.id !== 'string' ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.email !== 'string' ||
    row.has_user !== true
  ) {
    throw new AuthInfrastructureError();
  }

  try {
    const stored = normalizeEmail(row.email);
    if (stored !== row.email || stored !== email) {
      throw new AuthInfrastructureError();
    }
    return Object.freeze({ userId: row.id, email: stored });
  } catch {
    throw new AuthInfrastructureError();
  }
}

export function createCanonicalIdentityByEmailLookup(
  database: CanonicalIdentityQuery,
): CanonicalIdentityByEmailLookup {
  return (email) => findCanonicalIdentityByEmail(database, email);
}

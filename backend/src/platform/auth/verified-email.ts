import type { Pool } from 'pg';
import {
  normalizeEmail,
  type NormalizedEmail,
} from '../../../auth-runtime/src/index.js';
import { AuthInfrastructureError } from './errors.js';

export type VerifiedEmailIdentity = Readonly<{
  userId: string;
  email: NormalizedEmail;
}>;

export type VerifiedEmailLookup = (
  userId: string,
) => Promise<VerifiedEmailIdentity | null>;

type VerifiedEmailRow = {
  id: unknown;
  email: unknown;
};

/**
 * Reads verification truth from the Better Auth-owned identity row. It does
 * not trust request input or a previously captured session projection.
 */
export function createVerifiedEmailLookup(pool: Pool): VerifiedEmailLookup {
  return async (userId) => {
    let rows: VerifiedEmailRow[];
    try {
      const result = await pool.query<VerifiedEmailRow>(
        `SELECT id, email
         FROM auth_identities
         WHERE id = $1
           AND email_verified = true
         LIMIT 2`,
        [userId],
      );
      rows = result.rows;
    } catch {
      throw new AuthInfrastructureError();
    }

    const row = rows[0];
    if (rows.length === 0) {
      return null;
    }
    if (
      rows.length !== 1 ||
      row === undefined ||
      typeof row.id !== 'string' ||
      row.id !== userId ||
      typeof row.email !== 'string'
    ) {
      throw new AuthInfrastructureError();
    }

    try {
      const email = normalizeEmail(row.email);
      if (email !== row.email) {
        throw new AuthInfrastructureError();
      }
      return Object.freeze({ userId: row.id, email });
    } catch {
      throw new AuthInfrastructureError();
    }
  };
}

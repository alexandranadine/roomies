import type { Pool } from 'pg';
import {
  AuthorizationIntegrityError,
  isMembershipRole,
} from '../../../platform/authz/index.js';
import type { ActiveHomeSummary } from '../active-home-summary.js';

/**
 * Canonical User → active Membership → unarchived Home.
 * Name + id ordering is stable and non-sensitive.
 */
export const LIST_ACTIVE_HOMES_FOR_USER_SQL = `
SELECT
  h.id,
  h.name,
  h.timezone,
  m.role
FROM memberships AS m
JOIN homes AS h
  ON h.id = m.home_id
WHERE m.user_id = $1
  AND m.ended_at IS NULL
  AND h.archived_at IS NULL
ORDER BY h.name ASC, h.id ASC
`;

export type ActiveHomesForUserReader = {
  listActiveHomesForUser(userId: string): Promise<readonly ActiveHomeSummary[]>;
};

type ActiveHomeRow = {
  id: unknown;
  name: unknown;
  timezone: unknown;
  role: unknown;
};

function logIntegrityFailure(kind: 'lookup' | 'row' | 'role'): void {
  console.error('[authz] authorization integrity failure', {
    errorClass: kind,
  });
}

export function createActiveHomesForUserReader(
  pool: Pool,
): ActiveHomesForUserReader {
  return {
    async listActiveHomesForUser(userId) {
      let rows: ActiveHomeRow[];
      try {
        const result = await pool.query<ActiveHomeRow>(
          LIST_ACTIVE_HOMES_FOR_USER_SQL,
          [userId],
        );
        rows = result.rows;
      } catch {
        logIntegrityFailure('lookup');
        throw new AuthorizationIntegrityError();
      }

      const homes: ActiveHomeSummary[] = [];
      for (const row of rows) {
        if (
          typeof row.id !== 'string' ||
          typeof row.name !== 'string' ||
          typeof row.timezone !== 'string'
        ) {
          logIntegrityFailure('row');
          throw new AuthorizationIntegrityError();
        }
        if (!isMembershipRole(row.role)) {
          logIntegrityFailure('role');
          throw new AuthorizationIntegrityError();
        }
        homes.push(
          Object.freeze({
            id: row.id,
            name: row.name,
            timezone: row.timezone,
            role: row.role,
          }),
        );
      }
      return Object.freeze(homes);
    },
  };
}

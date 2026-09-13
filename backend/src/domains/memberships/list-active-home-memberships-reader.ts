import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import type { ActiveHomeMembershipListItem } from './active-home-membership-list.js';

/**
 * Home-scoped active Membership list. AuthIdentity.name is the approved
 * display field. Ordered by name ASC, membershipId ASC for a stable picker.
 * No invitation join and no historical tenures.
 */
export const LIST_ACTIVE_HOME_MEMBERSHIPS_SQL = `
SELECT
  m.id AS membership_id,
  i.name AS name
FROM memberships AS m
INNER JOIN auth_identities AS i
  ON i.id = m.user_id
WHERE m.home_id = $1::uuid
  AND m.ended_at IS NULL
ORDER BY i.name ASC, m.id ASC
`;

export type ActiveHomeMembershipsQueryable = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

export type ActiveHomeMembershipsReader = {
  listActiveByHome(
    homeId: string,
  ): Promise<readonly ActiveHomeMembershipListItem[]>;
};

type ActiveHomeMembershipRow = {
  membership_id: unknown;
  name: unknown;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function logIntegrityFailure(kind: 'lookup' | 'row' | 'scope'): void {
  console.error('[memberships] active Home Membership list integrity failure', {
    errorClass: kind,
  });
}

export function createActiveHomeMembershipsReader(
  pool: ActiveHomeMembershipsQueryable,
): ActiveHomeMembershipsReader {
  return {
    async listActiveByHome(homeId) {
      if (!isUuid(homeId)) {
        logIntegrityFailure('scope');
        throw new AuthorizationIntegrityError();
      }

      let rows: ActiveHomeMembershipRow[];
      try {
        const result = await pool.query<ActiveHomeMembershipRow>(
          LIST_ACTIVE_HOME_MEMBERSHIPS_SQL,
          [homeId],
        );
        rows = result.rows;
      } catch {
        logIntegrityFailure('lookup');
        throw new AuthorizationIntegrityError();
      }

      const memberships: ActiveHomeMembershipListItem[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (
          !isUuid(row.membership_id) ||
          typeof row.name !== 'string' ||
          row.name.length === 0 ||
          seen.has(row.membership_id)
        ) {
          logIntegrityFailure('row');
          throw new AuthorizationIntegrityError();
        }
        seen.add(row.membership_id);
        memberships.push(
          Object.freeze({
            membershipId: row.membership_id,
            name: row.name,
          }),
        );
      }
      return Object.freeze(memberships);
    },
  };
}

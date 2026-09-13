import { AuthorizationIntegrityError } from '../../platform/authz/errors.js';
import type { ActiveHomeSummary } from './active-home-summary.js';
import type { ActiveHomesForUserReader } from './repository/active-homes-for-user.js';

/**
 * Fail closed when persistence yields two current tenures for the same Home.
 * Callers must not pick an arbitrary row as authority.
 */
export function assertUniqueActiveHomeIds(
  homes: readonly Pick<ActiveHomeSummary, 'id'>[],
): void {
  const seen = new Set<string>();
  for (const home of homes) {
    if (seen.has(home.id)) {
      throw new AuthorizationIntegrityError();
    }
    seen.add(home.id);
  }
}

/**
 * List Homes the canonical User may currently enter: active Membership joined
 * to an unarchived Home. Ordering is applied by the reader.
 */
export async function listActiveHomesForUser(
  input: { userId: string },
  homes: Pick<ActiveHomesForUserReader, 'listActiveHomesForUser'>,
): Promise<readonly ActiveHomeSummary[]> {
  const rows = await homes.listActiveHomesForUser(input.userId);
  assertUniqueActiveHomeIds(rows);
  return rows;
}

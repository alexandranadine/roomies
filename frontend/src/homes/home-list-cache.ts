import type { QueryClient } from '@tanstack/react-query';
import type { CreatedHome } from './create-home-api.js';
import { currentUserHomesQueryKey } from './home-query-keys.js';
import type { ActiveHome } from './homes-api.js';

/** Maps authoritative POST /homes response fields to GET /me/homes row shape. */
export function toActiveHomeFromCreated(created: CreatedHome): ActiveHome {
  return {
    id: created.home.id,
    name: created.home.name,
    timezone: created.home.timezone,
    hasPhoto: created.home.hasPhoto,
    role: created.membership.role,
  };
}

function compareActiveHomesByNameThenId(
  a: ActiveHome,
  b: ActiveHome,
): number {
  const byName = a.name.localeCompare(b.name);
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * After successful Home creation: insert the authoritative row into an
 * existing /me/homes cache. Skips when cache is undefined (list may be
 * incomplete). Background invalidation still reconciles order and roles.
 */
export function seedCurrentUserHomesCacheAfterCreate(
  queryClient: QueryClient,
  created: CreatedHome,
): void {
  const entry = toActiveHomeFromCreated(created);

  queryClient.setQueryData(
    currentUserHomesQueryKey,
    (homes: readonly ActiveHome[] | undefined) => {
      if (homes === undefined) {
        return homes;
      }
      if (homes.some((home) => home.id === entry.id)) {
        return homes;
      }
      return [...homes, entry].sort(compareActiveHomesByNameThenId);
    },
  );
}

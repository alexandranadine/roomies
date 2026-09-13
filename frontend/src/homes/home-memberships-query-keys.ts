/**
 * Home-scoped active Memberships query keys.
 * Every key includes homeId so caches never cross Homes.
 */
export const homeMembershipsKeys = {
  all: (homeId: string) => ['home', homeId, 'memberships'] as const,
};

/**
 * Home-scoped Activity query keys.
 * Every key includes homeId so caches never cross Homes.
 */
export const activityKeys = {
  all: (homeId: string) => ['home', homeId, 'activity'] as const,
  list: (homeId: string) => ['home', homeId, 'activity', 'list'] as const,
};

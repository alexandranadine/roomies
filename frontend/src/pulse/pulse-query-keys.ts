/**
 * Home-scoped House Pulse query keys.
 * Every key includes homeId so caches never cross Homes.
 */
export const pulseKeys = {
  all: (homeId: string) => ['home', homeId, 'pulse'] as const,
};

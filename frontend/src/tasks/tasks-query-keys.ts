/**
 * Home-scoped Tasks query keys.
 * Every key includes homeId so caches never cross Homes.
 */
export const taskKeys = {
  all: (homeId: string) => ['home', homeId, 'tasks'] as const,
  list: (homeId: string) => ['home', homeId, 'tasks', 'list'] as const,
  definitions: (homeId: string) =>
    ['home', homeId, 'tasks', 'definitions'] as const,
};

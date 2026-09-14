/**
 * Global Notification query keys — never include homeId.
 * Memory-only TanStack Query state; not persisted.
 */
export const notificationKeys = {
  all: ['notifications'] as const,
  lists: () => [...notificationKeys.all, 'list'] as const,
  list: (params: Record<string, unknown> = {}) =>
    [...notificationKeys.lists(), params] as const,
};

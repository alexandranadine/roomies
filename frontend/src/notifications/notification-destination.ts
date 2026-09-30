import type { NotificationDestination } from './notifications-api.js';

/**
 * Resolve a frozen Notification destination to an existing app route.
 *
 * Task notifications open the Home Tasks list (no task-detail route yet).
 * Supply detail routes are not live yet — fall back to the destination Home
 * overview. Always uses destination.homeId (never the currently active Home).
 * PRIVATE Maintenance opens the Home Maintenance list and must never
 * construct a Maintenance detail URL.
 */
export function notificationDestinationPath(
  destination: NotificationDestination,
): string {
  const homePath = `/homes/${encodeURIComponent(destination.homeId)}`;

  switch (destination.type) {
    case 'TASK':
      return `${homePath}/tasks`;
    case 'SUPPLY':
      return homePath;
    case 'ROOMMATES':
      return `${homePath}/roommates`;
    case 'MAINTENANCE':
      return `${homePath}/maintenance`;
    case 'HOME':
      return homePath;
  }
}

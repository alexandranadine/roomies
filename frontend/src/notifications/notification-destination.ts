import type { NotificationDestination } from './notifications-api.js';

/**
 * Resolve a frozen Notification destination to an existing app route.
 *
 * Task and Supply detail routes are not live yet — fall back to the
 * destination Home overview. Always uses destination.homeId (never the
 * currently active Home). PRIVATE Maintenance is HOME-only and must never
 * construct a Maintenance detail URL.
 */
export function notificationDestinationPath(
  destination: NotificationDestination,
): string {
  const homePath = `/homes/${encodeURIComponent(destination.homeId)}`;

  switch (destination.type) {
    case 'TASK':
      return homePath;
    case 'SUPPLY':
      return homePath;
    case 'ROOMMATES':
      return `${homePath}/roommates`;
    case 'HOME':
      return homePath;
  }
}

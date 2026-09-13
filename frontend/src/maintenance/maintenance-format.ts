import type { MaintenanceStatus } from './maintenance-api.js';

export function formatMaintenanceStatus(status: MaintenanceStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open';
    case 'RESOLVED':
      return 'Resolved';
  }
}

export function formatMaintenanceTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

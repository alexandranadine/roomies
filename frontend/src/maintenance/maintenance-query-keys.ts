import type { MaintenanceStatus } from './maintenance-api.js';

export type MaintenanceListFilter = {
  status?: MaintenanceStatus;
};

/**
 * Home-scoped Maintenance query keys.
 * Every key includes homeId so caches never cross Homes.
 */
export const maintenanceKeys = {
  all: (homeId: string) => ['home', homeId, 'maintenance'] as const,
  list: (homeId: string, filters: MaintenanceListFilter = {}) =>
    ['home', homeId, 'maintenance', 'list', filters] as const,
  detail: (homeId: string, maintenanceEntryId: string) =>
    ['home', homeId, 'maintenance', 'detail', maintenanceEntryId] as const,
};

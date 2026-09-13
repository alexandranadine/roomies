import { useQuery } from '@tanstack/react-query';
import { shouldRetryQuery } from '../platform/query/query-client.js';
import { getMaintenanceEntry } from './maintenance-api.js';
import { maintenanceKeys } from './maintenance-query-keys.js';

export type UseMaintenanceDetailOptions = {
  homeId: string;
  maintenanceEntryId: string;
  enabled?: boolean;
};

/** Single Maintenance detail for one Home. */
export function useMaintenanceDetail(options: UseMaintenanceDetailOptions) {
  const { homeId, maintenanceEntryId, enabled = true } = options;

  return useQuery({
    queryKey: maintenanceKeys.detail(homeId, maintenanceEntryId),
    queryFn: ({ signal }) =>
      getMaintenanceEntry(homeId, maintenanceEntryId, signal),
    enabled: enabled && homeId.length > 0 && maintenanceEntryId.length > 0,
    retry: shouldRetryQuery,
  });
}

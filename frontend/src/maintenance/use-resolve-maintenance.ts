import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../platform/api/index.js';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import {
  resolveMaintenanceEntry,
  type MaintenanceDetail,
} from './maintenance-api.js';
import { seedMaintenanceListCachesAfterResolve } from './maintenance-list-cache.js';
import { maintenanceKeys } from './maintenance-query-keys.js';

export type ResolveMaintenanceVariables = {
  homeId: string;
  maintenanceEntryId: string;
};

/**
 * Resolves a visible OPEN Maintenance entry.
 * On 404: clears the detail cache so protected content cannot linger.
 * On success: seeds detail + list caches from the response and invalidates
 * same-Home lists + Pulse in the background.
 */
export function useResolveMaintenance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ homeId, maintenanceEntryId }: ResolveMaintenanceVariables) =>
      resolveMaintenanceEntry(homeId, maintenanceEntryId),
    onSuccess: (resolved: MaintenanceDetail, variables) => {
      queryClient.setQueryData(
        maintenanceKeys.detail(variables.homeId, variables.maintenanceEntryId),
        resolved,
      );
      seedMaintenanceListCachesAfterResolve(
        queryClient,
        variables.homeId,
        resolved,
      );
      void queryClient.invalidateQueries({
        queryKey: [...maintenanceKeys.all(variables.homeId), 'list'],
      });
      void queryClient.invalidateQueries({
        queryKey: pulseKeys.all(variables.homeId),
      });
    },
    onError: (error, variables) => {
      if (
        error instanceof ApiError &&
        (error.status === 404 || error.code === 'NOT_FOUND')
      ) {
        queryClient.removeQueries({
          queryKey: maintenanceKeys.detail(
            variables.homeId,
            variables.maintenanceEntryId,
          ),
        });
      }
    },
    retry: false,
  });
}

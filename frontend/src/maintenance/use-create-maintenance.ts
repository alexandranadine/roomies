import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import {
  createMaintenanceEntry,
  type CreateMaintenanceBody,
  type MaintenanceDetail,
} from './maintenance-api.js';
import { maintenanceKeys } from './maintenance-query-keys.js';

export type CreateMaintenanceVariables = {
  homeId: string;
  body: CreateMaintenanceBody;
};

/**
 * Creates a Maintenance entry for one Home.
 * On success: seeds detail cache and invalidates same-Home lists + Pulse.
 */
export function useCreateMaintenance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ homeId, body }: CreateMaintenanceVariables) =>
      createMaintenanceEntry(homeId, body),
    onSuccess: (created: MaintenanceDetail, variables) => {
      queryClient.setQueryData(
        maintenanceKeys.detail(variables.homeId, created.id),
        created,
      );
      void queryClient.invalidateQueries({
        queryKey: [...maintenanceKeys.all(variables.homeId), 'list'],
      });
      void queryClient.invalidateQueries({
        queryKey: pulseKeys.all(variables.homeId),
      });
    },
    retry: false,
  });
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  deactivateHomeTaskDefinition,
  type TaskDefinition,
} from './tasks-api.js';
import { taskKeys } from './tasks-query-keys.js';

export type DeactivateTaskDefinitionVariables = {
  homeId: string;
  taskDefinitionId: string;
};

function replaceDefinition(
  list: TaskDefinition[] | undefined,
  next: TaskDefinition,
): TaskDefinition[] | undefined {
  if (list === undefined) {
    return [next];
  }
  return list.map((row) => (row.id === next.id ? next : row));
}

/**
 * Deactivates an active TaskDefinition (creator or Home Admin).
 * Existing TaskInstances are left in place by the backend.
 */
export function useDeactivateTaskDefinition() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ homeId, taskDefinitionId }: DeactivateTaskDefinitionVariables) =>
      deactivateHomeTaskDefinition(homeId, taskDefinitionId),
    onSuccess: (deactivated: TaskDefinition, variables) => {
      queryClient.setQueryData<TaskDefinition[]>(
        taskKeys.definitions(variables.homeId),
        (current) => replaceDefinition(current, deactivated),
      );
      void queryClient.invalidateQueries({
        queryKey: taskKeys.definitions(variables.homeId),
      });
    },
    retry: false,
  });
}

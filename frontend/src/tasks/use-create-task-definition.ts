import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import {
  createHomeTaskDefinition,
  type CreateTaskDefinitionBody,
  type TaskDefinition,
} from './tasks-api.js';
import { taskKeys } from './tasks-query-keys.js';

export type CreateTaskDefinitionVariables = {
  homeId: string;
  body: CreateTaskDefinitionBody;
};

/**
 * Creates a recurring TaskDefinition. No TaskInstance is generated.
 * On success: invalidates same-Home definitions + Pulse.
 */
export function useCreateTaskDefinition() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ homeId, body }: CreateTaskDefinitionVariables) =>
      createHomeTaskDefinition(homeId, body),
    onSuccess: (created: TaskDefinition, variables) => {
      queryClient.setQueryData<TaskDefinition[]>(
        taskKeys.definitions(variables.homeId),
        (current) => {
          if (current === undefined) {
            return [created];
          }
          if (current.some((row) => row.id === created.id)) {
            return current;
          }
          return [created, ...current];
        },
      );
      void queryClient.invalidateQueries({
        queryKey: taskKeys.definitions(variables.homeId),
      });
      void queryClient.invalidateQueries({
        queryKey: pulseKeys.all(variables.homeId),
      });
    },
    retry: false,
  });
}

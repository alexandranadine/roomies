import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import {
  createHomeTask,
  type CreateTaskBody,
  type Task,
} from './tasks-api.js';
import { taskKeys } from './tasks-query-keys.js';

export type CreateTaskVariables = {
  homeId: string;
  body: CreateTaskBody;
};

/**
 * Creates a one-time TaskInstance.
 * On success: prepends the created row and invalidates same-Home Pulse.
 */
export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ homeId, body }: CreateTaskVariables) =>
      createHomeTask(homeId, body),
    onSuccess: (created: Task, variables) => {
      queryClient.setQueryData<Task[]>(taskKeys.list(variables.homeId), (current) => {
        if (current === undefined) {
          return [created];
        }
        if (current.some((task) => task.id === created.id)) {
          return current;
        }
        return [created, ...current];
      });
      void queryClient.invalidateQueries({
        queryKey: taskKeys.list(variables.homeId),
      });
      void queryClient.invalidateQueries({
        queryKey: pulseKeys.all(variables.homeId),
      });
    },
    retry: false,
  });
}

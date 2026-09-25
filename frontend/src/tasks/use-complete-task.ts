import { useMutation, useQueryClient } from '@tanstack/react-query';
import { activityKeys } from '../activity/activity-query-keys.js';
import { ApiError } from '../platform/api/index.js';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import { completeHomeTask, type Task } from './tasks-api.js';
import { taskKeys } from './tasks-query-keys.js';

export type CompleteTaskVariables = {
  homeId: string;
  taskId: string;
};

function replaceTask(list: Task[] | undefined, next: Task): Task[] | undefined {
  if (list === undefined) {
    return [next];
  }
  return list.map((task) => (task.id === next.id ? next : task));
}

/**
 * Completes one OPEN TaskInstance as the current actor.
 * Does not mark complete until the backend succeeds.
 */
export function useCompleteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ homeId, taskId }: CompleteTaskVariables) =>
      completeHomeTask(homeId, taskId),
    onSuccess: (completed: Task, variables) => {
      queryClient.setQueryData<Task[]>(taskKeys.list(variables.homeId), (current) =>
        replaceTask(current, completed),
      );
      void queryClient.invalidateQueries({
        queryKey: taskKeys.list(variables.homeId),
      });
      void queryClient.invalidateQueries({
        queryKey: pulseKeys.all(variables.homeId),
      });
      void queryClient.invalidateQueries({
        queryKey: activityKeys.list(variables.homeId),
      });
    },
    onError: (error, variables) => {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'TASK_ALREADY_COMPLETED'
      ) {
        void queryClient.invalidateQueries({
          queryKey: taskKeys.list(variables.homeId),
        });
      }
    },
    retry: false,
  });
}

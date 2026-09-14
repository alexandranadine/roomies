import { useMutation, useQueryClient } from '@tanstack/react-query';
import { readAllNotifications } from './notifications-api.js';
import { notificationKeys } from './notifications-query-keys.js';

/**
 * Marks every currently eligible Notification as read.
 * No optimistic mass mutation — invalidate the global list on success.
 */
export function useReadAllNotifications() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => readAllNotifications(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
    retry: false,
  });
}

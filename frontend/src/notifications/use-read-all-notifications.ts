import { useMutation, useQueryClient } from '@tanstack/react-query';
import { markAllNotificationsReadInCache } from './notifications-list-cache.js';
import { readAllNotifications } from './notifications-api.js';
import { notificationKeys } from './notifications-query-keys.js';

/**
 * Marks every currently eligible Notification as read.
 * No optimistic mass mutation — update cached rows on success, then invalidate.
 */
export function useReadAllNotifications() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => readAllNotifications(),
    onSuccess: () => {
      markAllNotificationsReadInCache(queryClient);
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
    retry: false,
  });
}

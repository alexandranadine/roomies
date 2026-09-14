import { Router } from 'express';
import type { ListCurrentUserNotificationsInput } from '../../application/notifications/list-current-user-notifications.js';
import type { MarkNotificationReadInput } from '../../application/notifications/mark-notification-read.js';
import type { ReadAllNotificationsInput } from '../../application/notifications/read-all-notifications.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import { InvalidRequestError } from '../../platform/authz/index.js';
import { parsePathUuid } from '../../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import {
  createRequireAuth,
  type RequestWithPrincipal,
} from '../../platform/http/require-auth.js';
import { z } from 'zod';
import type { NotificationListPage } from './notification-list-item.js';
import { toNotificationListPageDto } from './notification-dto.js';
import {
  NOTIFICATION_LIST_DEFAULT_LIMIT,
  NOTIFICATION_LIST_MAX_LIMIT,
  NOTIFICATION_LIST_MIN_LIMIT,
} from './cursor.js';

export type ListCurrentUserNotificationsCommand = (
  input: ListCurrentUserNotificationsInput,
) => Promise<NotificationListPage>;

export type MarkNotificationReadCommand = (
  input: MarkNotificationReadInput,
) => Promise<void>;

export type ReadAllNotificationsCommand = (
  input: ReadAllNotificationsInput,
) => Promise<void>;

export type CreateNotificationsRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  listCurrentUserNotifications: ListCurrentUserNotificationsCommand;
  markNotificationRead: MarkNotificationReadCommand;
  readAllNotifications: ReadAllNotificationsCommand;
};

const emptyNotificationMutationBodySchema = z.object({}).strict();

function parseListLimitQuery(value: unknown): number {
  if (value === undefined) {
    return NOTIFICATION_LIST_DEFAULT_LIMIT;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new InvalidRequestError();
  }
  const limit = Number(value);
  if (
    !Number.isInteger(limit) ||
    String(limit) !== value ||
    limit < NOTIFICATION_LIST_MIN_LIMIT ||
    limit > NOTIFICATION_LIST_MAX_LIMIT
  ) {
    throw new InvalidRequestError();
  }
  return limit;
}

function parseListCursorQuery(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestError();
  }
  return value;
}

function parseNotificationListQuery(query: unknown): {
  limit: number;
  cursor?: string;
} {
  if (query === undefined || query === null || typeof query !== 'object') {
    throw new InvalidRequestError();
  }

  const record = query as Record<string, unknown>;
  const limit = parseListLimitQuery(record.limit);
  const cursor = parseListCursorQuery(record.cursor);
  return {
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

function parseEmptyNotificationMutationBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  const parsed = emptyNotificationMutationBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
}

/**
 * Authenticated current-user Notification routes. Mount at `/notifications`
 * on the v1 router. There is no Home context or homeId route parameter.
 */
export function createNotificationsRouter(
  options: CreateNotificationsRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));

  router.get('/', (req, res, next) => {
    void (async () => {
      const { principal } = req as RequestWithPrincipal;
      const query = parseNotificationListQuery(req.query);
      const page = await options.listCurrentUserNotifications({
        userId: principal.userId,
        ...query,
      });
      res.status(200).json(toNotificationListPageDto(page));
    })().catch(next);
  });

  router.post('/read-all', (req, res, next) => {
    void (async () => {
      parseEmptyNotificationMutationBody(req.body);
      const { principal } = req as RequestWithPrincipal;
      await options.readAllNotifications({ userId: principal.userId });
      res.status(204).end();
    })().catch(next);
  });

  router.post('/:notificationId/read', (req, res, next) => {
    void (async () => {
      parseEmptyNotificationMutationBody(req.body);
      const { principal } = req as unknown as RequestWithPrincipal;
      const notificationId = parsePathUuid(req.params['notificationId']);
      await options.markNotificationRead({
        userId: principal.userId,
        notificationId,
      });
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

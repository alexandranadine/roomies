import { Router } from 'express';
import type { ListHomeActivityInput } from '../../application/activity/list-home-activity.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import {
  InvalidRequestError,
  type ActiveHomeActorResolver,
} from '../../platform/authz/index.js';
import {
  createRequireHomeContext,
  getActiveHomeActor,
} from '../../platform/http/home-context.js';
import { parsePathUuid } from '../../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import { createRequireAuth } from '../../platform/http/require-auth.js';
import type { ActivityListPage } from './activity-list-item.js';
import { toActivityListPageDto } from './activity-dto.js';
import {
  ACTIVITY_LIST_DEFAULT_LIMIT,
  ACTIVITY_LIST_MAX_LIMIT,
  ACTIVITY_LIST_MIN_LIMIT,
} from './cursor.js';

export type ListHomeActivityCommand = (
  input: ListHomeActivityInput,
) => Promise<ActivityListPage>;

export type CreateActivityRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  listHomeActivity: ListHomeActivityCommand;
};

function parseListLimitQuery(value: unknown): number {
  if (value === undefined) {
    return ACTIVITY_LIST_DEFAULT_LIMIT;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new InvalidRequestError();
  }
  const limit = Number(value);
  if (
    !Number.isInteger(limit) ||
    String(limit) !== value ||
    limit < ACTIVITY_LIST_MIN_LIMIT ||
    limit > ACTIVITY_LIST_MAX_LIMIT
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

function parseActivityListQuery(query: unknown): {
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

/**
 * Authenticated Home Activity routes. Mount at `/homes` on the v1 router.
 */
export function createActivityRouter(
  options: CreateActivityRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.get('/:homeId/activity', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const query = parseActivityListQuery(req.query);
      const page = await options.listHomeActivity({
        actor,
        homeId,
        ...query,
      });
      res.status(200).json(toActivityListPageDto(page));
    })().catch(next);
  });

  return router;
}

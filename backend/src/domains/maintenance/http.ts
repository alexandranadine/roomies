import { Router } from 'express';
import { z } from 'zod';
import type { CreateMaintenanceEntryInput } from '../../application/maintenance/create-maintenance-entry.js';
import type { ListHomeMaintenanceInput } from '../../application/maintenance/list-home-maintenance.js';
import type { ReadMaintenanceEntryInput } from '../../application/maintenance/read-maintenance-entry.js';
import type { ResolveMaintenanceEntryInput } from '../../application/maintenance/resolve-maintenance-entry.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import {
  InvalidRequestError,
  type ActiveHomeActorResolver,
} from '../../platform/authz/index.js';
import {
  createRequireHomeContext,
  getActiveHomeActor,
} from '../../platform/http/home-context.js';
import { parsePathUuid, pathUuidSchema } from '../../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import { createRequireAuth } from '../../platform/http/require-auth.js';
import {
  MAINTENANCE_LIST_DEFAULT_LIMIT,
  MAINTENANCE_LIST_MAX_LIMIT,
  MAINTENANCE_LIST_MIN_LIMIT,
} from './cursor.js';
import {
  InvalidMaintenanceDetailsError,
  InvalidMaintenanceTitleError,
} from './errors.js';
import {
  toMaintenanceDetailDto,
  toMaintenanceListPageDto,
} from './maintenance-entry-dto.js';
import { normalizeMaintenanceDetails } from './maintenance-details.js';
import { normalizeMaintenanceTitle } from './maintenance-title.js';
import {
  isMaintenanceStatus,
  type MaintenanceDetailProjection,
  type MaintenanceListItemProjection,
  type MaintenanceStatus,
} from './maintenance.js';

const createMaintenanceHouseholdBodySchema = z
  .object({
    visibility: z.literal('HOUSEHOLD'),
    title: z.string(),
    details: z.string().nullable().optional(),
  })
  .strict();

const createMaintenancePrivateBodySchema = z
  .object({
    visibility: z.literal('PRIVATE'),
    title: z.string(),
    details: z.string().nullable().optional(),
    audienceMembershipIds: z.array(pathUuidSchema),
  })
  .strict();

const createMaintenanceBodySchema = z.discriminatedUnion('visibility', [
  createMaintenanceHouseholdBodySchema,
  createMaintenancePrivateBodySchema,
]);

const emptyMaintenanceMutationBodySchema = z.object({}).strict();

export type CreateMaintenanceEntryCommand = (
  input: CreateMaintenanceEntryInput,
) => Promise<MaintenanceDetailProjection>;

export type ListHomeMaintenanceCommand = (
  input: ListHomeMaintenanceInput,
) => Promise<{
  items: readonly MaintenanceListItemProjection[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

export type ReadMaintenanceEntryCommand = (
  input: ReadMaintenanceEntryInput,
) => Promise<MaintenanceDetailProjection>;

export type ResolveMaintenanceEntryCommand = (
  input: ResolveMaintenanceEntryInput,
) => Promise<MaintenanceDetailProjection>;

export type CreateMaintenanceRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  createMaintenanceEntry: CreateMaintenanceEntryCommand;
  listHomeMaintenance: ListHomeMaintenanceCommand;
  readMaintenanceEntry: ReadMaintenanceEntryCommand;
  resolveMaintenanceEntry: ResolveMaintenanceEntryCommand;
};

function parseEmptyMaintenanceMutationBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  const parsed = emptyMaintenanceMutationBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
}

function parseCreateMaintenanceBody(body: unknown): {
  visibility: 'HOUSEHOLD' | 'PRIVATE';
  title: string;
  details: string | null;
  audienceMembershipIds?: readonly string[];
} {
  const parsed = createMaintenanceBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }

  try {
    const title = normalizeMaintenanceTitle(parsed.data.title);
    const details = normalizeMaintenanceDetails(parsed.data.details);
    if (parsed.data.visibility === 'HOUSEHOLD') {
      return {
        visibility: 'HOUSEHOLD',
        title,
        details,
      };
    }
    return {
      visibility: 'PRIVATE',
      title,
      details,
      audienceMembershipIds: parsed.data.audienceMembershipIds,
    };
  } catch (error) {
    if (
      error instanceof InvalidMaintenanceTitleError ||
      error instanceof InvalidMaintenanceDetailsError
    ) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

function parseListLimitQuery(value: unknown): number {
  if (value === undefined) {
    return MAINTENANCE_LIST_DEFAULT_LIMIT;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new InvalidRequestError();
  }
  const limit = Number(value);
  if (
    !Number.isInteger(limit) ||
    String(limit) !== value ||
    limit < MAINTENANCE_LIST_MIN_LIMIT ||
    limit > MAINTENANCE_LIST_MAX_LIMIT
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

function parseListStatusQuery(value: unknown): MaintenanceStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) || !isMaintenanceStatus(value)) {
    throw new InvalidRequestError();
  }
  return value;
}

function parseMaintenanceListQuery(query: unknown): {
  limit: number;
  cursor?: string;
  status?: MaintenanceStatus;
} {
  if (query === undefined || query === null || typeof query !== 'object') {
    throw new InvalidRequestError();
  }

  const record = query as Record<string, unknown>;
  const limit = parseListLimitQuery(record.limit);
  const cursor = parseListCursorQuery(record.cursor);
  const status = parseListStatusQuery(record.status);
  return {
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * Authenticated Home Maintenance routes. Mount at `/homes` on the v1 router.
 */
export function createMaintenanceRouter(
  options: CreateMaintenanceRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.post('/:homeId/maintenance', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const body = parseCreateMaintenanceBody(req.body);
      const created = await options.createMaintenanceEntry({
        actor,
        homeId,
        visibility: body.visibility,
        title: body.title,
        details: body.details,
        ...(body.audienceMembershipIds !== undefined
          ? { audienceMembershipIds: body.audienceMembershipIds }
          : {}),
      });
      res.status(201).json(toMaintenanceDetailDto(created));
    })().catch(next);
  });

  router.get('/:homeId/maintenance', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const query = parseMaintenanceListQuery(req.query);
      const page = await options.listHomeMaintenance({
        actor,
        homeId,
        ...query,
      });
      res.status(200).json(toMaintenanceListPageDto(page));
    })().catch(next);
  });

  router.get('/:homeId/maintenance/:maintenanceEntryId', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const maintenanceEntryId = parsePathUuid(
        req.params['maintenanceEntryId'],
      );
      const entry = await options.readMaintenanceEntry({
        actor,
        homeId,
        maintenanceEntryId,
      });
      res.status(200).json(toMaintenanceDetailDto(entry));
    })().catch(next);
  });

  router.post(
    '/:homeId/maintenance/:maintenanceEntryId/resolve',
    (req, res, next) => {
      void (async () => {
        const actor = getActiveHomeActor(res);
        const homeId = parsePathUuid(req.params['homeId']);
        const maintenanceEntryId = parsePathUuid(
          req.params['maintenanceEntryId'],
        );
        parseEmptyMaintenanceMutationBody(req.body);
        const resolved = await options.resolveMaintenanceEntry({
          actor,
          homeId,
          maintenanceEntryId,
        });
        res.status(200).json(toMaintenanceDetailDto(resolved));
      })().catch(next);
    },
  );

  return router;
}

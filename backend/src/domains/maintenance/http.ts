import { Router } from 'express';
import { z } from 'zod';
import type { CreateMaintenanceEntryInput } from '../../application/maintenance/create-maintenance-entry.js';
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
  InvalidMaintenanceDetailsError,
  InvalidMaintenanceTitleError,
} from './errors.js';
import { toMaintenanceDetailDto } from './maintenance-entry-dto.js';
import { normalizeMaintenanceDetails } from './maintenance-details.js';
import { normalizeMaintenanceTitle } from './maintenance-title.js';
import type { MaintenanceDetailProjection } from './maintenance.js';

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

export type CreateMaintenanceEntryCommand = (
  input: CreateMaintenanceEntryInput,
) => Promise<MaintenanceDetailProjection>;

export type CreateMaintenanceRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  createMaintenanceEntry: CreateMaintenanceEntryCommand;
};

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

  return router;
}

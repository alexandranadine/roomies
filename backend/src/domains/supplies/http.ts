import { Router } from 'express';
import { z } from 'zod';
import type { CreateSupplyEntryInput } from '../../application/supplies/create-supply-entry.js';
import type { ListHomeSuppliesInput } from '../../application/supplies/list-home-supplies.js';
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
import { InvalidSupplyTitleError } from './errors.js';
import {
  isSupplyEntryStatus,
  type SupplyEntry,
  type SupplyEntryStatus,
} from './supply.js';
import { toSupplyEntryDto, toSupplyEntryListDto } from './supply-entry-dto.js';
import { normalizeSupplyTitle } from './supply-title.js';

const createSupplyEntryBodySchema = z
  .object({
    title: z.string(),
  })
  .strict();

export type CreateSupplyEntryCommand = (
  input: CreateSupplyEntryInput,
) => Promise<SupplyEntry>;

export type ListHomeSuppliesCommand = (
  input: ListHomeSuppliesInput,
) => Promise<readonly SupplyEntry[]>;

export type CreateSuppliesRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  createSupplyEntry: CreateSupplyEntryCommand;
  listHomeSupplies: ListHomeSuppliesCommand;
};

function parseCreateSupplyEntryBody(body: unknown): { title: string } {
  const parsed = createSupplyEntryBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }

  try {
    return { title: normalizeSupplyTitle(parsed.data.title) };
  } catch (error) {
    if (error instanceof InvalidSupplyTitleError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

function parseListStatusQuery(query: unknown): SupplyEntryStatus | undefined {
  if (query === undefined || query === null || typeof query !== 'object') {
    throw new InvalidRequestError();
  }

  const status = (query as { status?: unknown }).status;
  if (status === undefined) {
    return undefined;
  }
  if (Array.isArray(status) || !isSupplyEntryStatus(status)) {
    throw new InvalidRequestError();
  }
  return status;
}

/**
 * Authenticated Home Supply routes. Mount at `/homes` on the v1 router.
 */
export function createSuppliesRouter(
  options: CreateSuppliesRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.post('/:homeId/supplies', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const body = parseCreateSupplyEntryBody(req.body);
      const created = await options.createSupplyEntry({
        actor,
        homeId,
        title: body.title,
      });
      res.status(201).json(toSupplyEntryDto(created));
    })().catch(next);
  });

  router.get('/:homeId/supplies', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const status = parseListStatusQuery(req.query);
      const entries = await options.listHomeSupplies({
        actor,
        homeId,
        status,
      });
      res.status(200).json(toSupplyEntryListDto(entries));
    })().catch(next);
  });

  return router;
}

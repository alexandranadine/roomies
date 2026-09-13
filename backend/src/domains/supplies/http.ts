import { Router } from 'express';
import { z } from 'zod';
import type { ClaimSupplyEntryInput } from '../../application/supplies/claim-supply-entry.js';
import type { CreateSupplyEntryInput } from '../../application/supplies/create-supply-entry.js';
import type { ListHomeSuppliesInput } from '../../application/supplies/list-home-supplies.js';
import type { ReleaseSupplyClaimInput } from '../../application/supplies/release-supply-claim.js';
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
import { toSupplyClaimDto } from './supply-claim-dto.js';
import {
  isSupplyEntryStatus,
  type ListedSupplyEntry,
  type SupplyClaim,
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

const emptySupplyMutationBodySchema = z.object({}).strict();

export type CreateSupplyEntryCommand = (
  input: CreateSupplyEntryInput,
) => Promise<SupplyEntry>;

export type ListHomeSuppliesCommand = (
  input: ListHomeSuppliesInput,
) => Promise<readonly ListedSupplyEntry[]>;

export type ClaimSupplyEntryCommand = (
  input: ClaimSupplyEntryInput,
) => Promise<SupplyClaim>;

export type ReleaseSupplyClaimCommand = (
  input: ReleaseSupplyClaimInput,
) => Promise<void>;

export type CreateSuppliesRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  createSupplyEntry: CreateSupplyEntryCommand;
  listHomeSupplies: ListHomeSuppliesCommand;
  claimSupplyEntry: ClaimSupplyEntryCommand;
  releaseSupplyClaim: ReleaseSupplyClaimCommand;
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

function parseEmptySupplyMutationBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  const parsed = emptySupplyMutationBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
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

  router.post('/:homeId/supplies/:supplyEntryId/claim', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const supplyEntryId = parsePathUuid(req.params['supplyEntryId']);
      parseEmptySupplyMutationBody(req.body);
      const claimed = await options.claimSupplyEntry({
        actor,
        homeId,
        supplyEntryId,
      });
      res.status(201).json(toSupplyClaimDto(claimed));
    })().catch(next);
  });

  router.post(
    '/:homeId/supplies/:supplyEntryId/release-claim',
    (req, res, next) => {
      void (async () => {
        const actor = getActiveHomeActor(res);
        const homeId = parsePathUuid(req.params['homeId']);
        const supplyEntryId = parsePathUuid(req.params['supplyEntryId']);
        parseEmptySupplyMutationBody(req.body);
        await options.releaseSupplyClaim({
          actor,
          homeId,
          supplyEntryId,
        });
        res.status(204).end();
      })().catch(next);
    },
  );

  return router;
}

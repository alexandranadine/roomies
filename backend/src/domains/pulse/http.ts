import { Router } from 'express';
import type { GetHousePulseInput } from '../../application/pulse/get-house-pulse.js';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import type { ActiveHomeActorResolver } from '../../platform/authz/index.js';
import {
  createRequireHomeContext,
  getActiveHomeActor,
} from '../../platform/http/home-context.js';
import { parsePathUuid } from '../../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import { createRequireAuth } from '../../platform/http/require-auth.js';
import type { HousePulse } from './house-pulse.js';
import { toHousePulseDto } from './house-pulse-dto.js';

export type GetHousePulseCommand = (
  input: GetHousePulseInput,
) => Promise<HousePulse>;

export type CreatePulseRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  getHousePulse: GetHousePulseCommand;
};

/**
 * Authenticated House Pulse routes. Mount at `/homes` on the v1 router.
 */
export function createPulseRouter(options: CreatePulseRouterOptions): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.get('/:homeId/pulse', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const pulse = await options.getHousePulse({
        actor,
        homeId,
      });
      res.status(200).json(toHousePulseDto(pulse));
    })().catch(next);
  });

  return router;
}

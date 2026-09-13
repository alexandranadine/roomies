import { Router } from 'express';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import {
  createRequireAuth,
  type RequestWithPrincipal,
} from '../../platform/http/require-auth.js';
import type { ActiveHomeSummary } from './active-home-summary.js';
import { toActiveHomesDto } from './active-home-summary-dto.js';

export type ListActiveHomesCommand = (input: {
  userId: string;
}) => Promise<readonly ActiveHomeSummary[]>;

export type CreateCurrentUserHomesRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  listActiveHomes: ListActiveHomesCommand;
};

/**
 * Authenticated active-Home discovery. Mount at `/me/homes` so `/me` stays a
 * User-identity surface and Home-context middleware never runs here.
 */
export function createCurrentUserHomesRouter(
  options: CreateCurrentUserHomesRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));

  router.get('/', (req, res, next) => {
    void (async () => {
      const { principal } = req as RequestWithPrincipal;
      const homes = await options.listActiveHomes({
        userId: principal.userId,
      });
      res.status(200).json(toActiveHomesDto(homes));
    })().catch(next);
  });

  return router;
}

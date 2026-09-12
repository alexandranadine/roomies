import { Router } from 'express';
import { z } from 'zod';
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
import { getHome } from './get-home.js';
import { toHomeDto } from './home-dto.js';
import type { HomeReader } from './repository/home-repository.js';
import type { ArchiveFinalMemberInput } from './archive-final-member.js';

const archiveFinalMemberBodySchema = z.object({}).strict();

export type ArchiveFinalMemberCommand = (
  input: ArchiveFinalMemberInput,
) => Promise<unknown>;

export type CreateHomesRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  homeReader: Pick<HomeReader, 'findActiveHomeById'>;
  archiveFinalMemberHome: ArchiveFinalMemberCommand;
};

function parseArchiveFinalMemberBody(body: unknown): void {
  if (!archiveFinalMemberBodySchema.safeParse(body).success) {
    throw new InvalidRequestError();
  }
}

/**
 * Authenticated Home-context routes. Mount at `/homes` on the v1 router.
 */
export function createHomesRouter(options: CreateHomesRouterOptions): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.get('/:homeId', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const home = await getHome({ actor, homeId }, options.homeReader);
      res.status(200).json(toHomeDto(home));
    })().catch(next);
  });

  router.post('/:homeId/archive-final-member', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      parseArchiveFinalMemberBody(req.body);
      await options.archiveFinalMemberHome({ actor, homeId });
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

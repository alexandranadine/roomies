import { Router } from 'express';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import {
  createRequireAuth,
  type RequestWithPrincipal,
} from '../../platform/http/require-auth.js';
import { toCurrentUserDto } from './current-user-dto.js';
import { getCurrentUser } from './get-current-user.js';

export type CreateCurrentUserRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
};

/**
 * Authenticated current-user routes. Mount at `/me` on the v1 router so
 * other `/api/v1` paths are not implicitly protected.
 */
export function createCurrentUserRouter(
  options: CreateCurrentUserRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));

  router.get('/', (req, res) => {
    const { principal } = req as RequestWithPrincipal;
    res.status(200).json(toCurrentUserDto(getCurrentUser(principal)));
  });

  return router;
}

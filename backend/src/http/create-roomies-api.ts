import { Router } from 'express';
import { createHomesRouter } from '../domains/homes/http.js';
import type { HomeReader } from '../domains/homes/index.js';
import {
  createMembershipsRouter,
  type ChangeMembershipRoleCommand,
} from '../domains/memberships/http.js';
import { createCurrentUserRouter } from '../domains/users/http.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import type { ActiveHomeActorResolver } from '../platform/authz/index.js';

export type CreateRoomiesApiRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  homeReader: Pick<HomeReader, 'findActiveHomeById'>;
  changeMembershipRole: ChangeMembershipRoleCommand;
};

/**
 * Product `/api/v1` router. Auth and Home context are applied per mounted
 * surface, not globally.
 */
export function createRoomiesApiRouter(
  options: CreateRoomiesApiRouterOptions,
): Router {
  const router = Router();
  router.use('/me', createCurrentUserRouter(options));
  router.use('/homes', createHomesRouter(options));
  router.use('/homes', createMembershipsRouter(options));
  return router;
}

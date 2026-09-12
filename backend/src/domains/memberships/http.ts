import { Router } from 'express';
import { z } from 'zod';
import type { PrincipalResolver } from '../../platform/auth/principal.js';
import {
  InvalidRequestError,
  MEMBERSHIP_ROLES,
  type ActiveHomeActorResolver,
  type MembershipRole,
} from '../../platform/authz/index.js';
import type { ChangeMembershipRoleInput } from './change-role.js';
import {
  createRequireHomeContext,
  getActiveHomeActor,
} from '../../platform/http/home-context.js';
import { parsePathUuid } from '../../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../../platform/http/private-response.js';
import { createRequireAuth } from '../../platform/http/require-auth.js';

const changeRoleBodySchema = z
  .object({
    role: z.enum(MEMBERSHIP_ROLES),
  })
  .strict();

export type ChangeMembershipRoleCommand = (
  input: ChangeMembershipRoleInput,
) => Promise<unknown>;

export type CreateMembershipsRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  changeMembershipRole: ChangeMembershipRoleCommand;
};

function parseChangeRoleBody(body: unknown): MembershipRole {
  const parsed = changeRoleBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
  return parsed.data.role;
}

/**
 * Membership mutation routes. Mount at `/homes` on the v1 router.
 */
export function createMembershipsRouter(
  options: CreateMembershipsRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.patch('/:homeId/memberships/:membershipId/role', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const membershipId = parsePathUuid(req.params['membershipId']);
      const role = parseChangeRoleBody(req.body);
      await options.changeMembershipRole({
        actor,
        homeId,
        membershipId,
        role,
      });
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

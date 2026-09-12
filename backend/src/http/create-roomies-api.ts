import { Router } from 'express';
import {
  createHomesRouter,
  type ArchiveFinalMemberCommand,
} from '../domains/homes/http.js';
import type { HomeReader } from '../domains/homes/index.js';
import {
  createMembershipsRouter,
  type ChangeMembershipRoleCommand,
  type LeaveMembershipCommand,
  type RemoveMembershipCommand,
} from '../domains/memberships/http.js';
import { createCurrentUserRouter } from '../domains/users/http.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import type { ActiveHomeActorResolver } from '../platform/authz/index.js';
import {
  createInvitationPreviewRouter,
  type PreviewInvitationCommand,
} from './invitation-preview.js';
import {
  createInvitationsRouter,
  type CreateInvitationCommand,
} from './invitations.js';

export type CreateRoomiesApiRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  homeReader: Pick<HomeReader, 'findActiveHomeById'>;
  archiveFinalMemberHome: ArchiveFinalMemberCommand;
  changeMembershipRole: ChangeMembershipRoleCommand;
  leaveMembership: LeaveMembershipCommand;
  removeMembership: RemoveMembershipCommand;
  invitations?: {
    createInvitation: CreateInvitationCommand;
    frontendOrigin: string;
  };
  previewInvitation?: PreviewInvitationCommand;
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
  if (options.invitations !== undefined) {
    router.use(
      '/homes',
      createInvitationsRouter({
        principalResolver: options.principalResolver,
        activeHomeActorResolver: options.activeHomeActorResolver,
        createInvitation: options.invitations.createInvitation,
        frontendOrigin: options.invitations.frontendOrigin,
      }),
    );
  }
  if (options.previewInvitation !== undefined) {
    router.use(
      '/invitations',
      createInvitationPreviewRouter({
        previewInvitation: options.previewInvitation,
      }),
    );
  }
  return router;
}

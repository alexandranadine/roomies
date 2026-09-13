import { Router } from 'express';
import {
  createCurrentUserHomesRouter,
  type ListActiveHomesCommand,
} from '../domains/homes/current-user-homes-http.js';
import {
  createHomesRouter,
  type ArchiveFinalMemberCommand,
  type CreateHomeCommand,
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
  createInvitationAcceptanceRouter,
  type AcceptInvitationCommand,
} from './invitation-acceptance.js';
import {
  createInvitationPreviewRouter,
  type PreviewInvitationCommand,
} from './invitation-preview.js';
import {
  createInvitationsRouter,
  type CreateInvitationCommand,
  type RevokeInvitationCommand,
} from './invitations.js';

export type CreateRoomiesApiRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  homeReader: Pick<HomeReader, 'findActiveHomeById'>;
  archiveFinalMemberHome: ArchiveFinalMemberCommand;
  createHome?: CreateHomeCommand;
  listActiveHomes?: ListActiveHomesCommand;
  changeMembershipRole: ChangeMembershipRoleCommand;
  leaveMembership: LeaveMembershipCommand;
  removeMembership: RemoveMembershipCommand;
  invitations?: {
    createInvitation: CreateInvitationCommand;
    revokeInvitation: RevokeInvitationCommand;
    frontendOrigin: string;
  };
  previewInvitation?: PreviewInvitationCommand;
  acceptInvitation?: AcceptInvitationCommand;
};

/**
 * Product `/api/v1` router. Auth and Home context are applied per mounted
 * surface, not globally.
 */
export function createRoomiesApiRouter(
  options: CreateRoomiesApiRouterOptions,
): Router {
  const router = Router();
  if (options.listActiveHomes !== undefined) {
    router.use(
      '/me/homes',
      createCurrentUserHomesRouter({
        principalResolver: options.principalResolver,
        listActiveHomes: options.listActiveHomes,
      }),
    );
  }
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
        revokeInvitation: options.invitations.revokeInvitation,
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
  if (options.acceptInvitation !== undefined) {
    router.use(
      '/invitations',
      createInvitationAcceptanceRouter({
        principalResolver: options.principalResolver,
        acceptInvitation: options.acceptInvitation,
      }),
    );
  }
  return router;
}

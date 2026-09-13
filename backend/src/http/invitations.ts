import { Router } from 'express';
import { z } from 'zod';
import type { CreateInvitationInput } from '../application/home-administration/create-invitation.js';
import type { RevokeInvitationInput } from '../application/home-administration/revoke-invitation.js';
import {
  InvalidNormalizedEmailError,
  normalizeEmail,
} from '../platform/auth/index.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import {
  InvalidRequestError,
  type ActiveHomeActorResolver,
} from '../platform/authz/index.js';
import { normalizeTrustedOrigin } from '../platform/config/normalize-origin.js';
import {
  createRequireHomeContext,
  getActiveHomeActor,
} from '../platform/http/home-context.js';
import { parsePathUuid } from '../platform/http/path-id.js';
import { setPrivateNoStoreHeaders } from '../platform/http/private-response.js';
import { createRequireAuth } from '../platform/http/require-auth.js';

const createInvitationBodySchema = z
  .object({
    email: z.string(),
  })
  .strict();

const revokeInvitationBodySchema = z.object({}).strict();

export const createdInvitationDtoSchema = z
  .object({
    invitation: z
      .object({
        id: z.string().min(1),
        email: z.string().min(1),
        expiresAt: z.string().min(1),
      })
      .strict(),
    inviteUrl: z.string().min(1),
  })
  .strict();

export type CreatedInvitationDto = z.infer<typeof createdInvitationDtoSchema>;

export type CreateInvitationCommand = (
  input: CreateInvitationInput,
) => Promise<{
  invitation: {
    id: string;
    email: string;
    expiresAt: Date;
  };
  rawSecret: string;
}>;

export type RevokeInvitationCommand = (
  input: RevokeInvitationInput,
) => Promise<void>;

export type CreateInvitationsRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  activeHomeActorResolver: Pick<ActiveHomeActorResolver, 'resolve'>;
  createInvitation: CreateInvitationCommand;
  revokeInvitation: RevokeInvitationCommand;
  frontendOrigin: string;
};

function parseRevokeInvitationBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  if (!revokeInvitationBodySchema.safeParse(body).success) {
    throw new InvalidRequestError();
  }
}

function parseCreateInvitationBody(body: unknown): string {
  const parsed = createInvitationBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidRequestError();
  }
  try {
    return normalizeEmail(parsed.data.email);
  } catch (error) {
    if (error instanceof InvalidNormalizedEmailError) {
      throw new InvalidRequestError();
    }
    throw error;
  }
}

export function buildInviteUrl(input: {
  frontendOrigin: string;
  invitationId: string;
  secret: string;
}): string {
  const origin = normalizeTrustedOrigin(input.frontendOrigin);
  return `${origin}/invitations/${input.invitationId}#secret=${input.secret}`;
}

function toCreatedInvitationDto(input: {
  frontendOrigin: string;
  invitation: {
    id: string;
    email: string;
    expiresAt: Date;
  };
  rawSecret: string;
}): CreatedInvitationDto {
  return createdInvitationDtoSchema.parse({
    invitation: {
      id: input.invitation.id,
      email: input.invitation.email,
      expiresAt: input.invitation.expiresAt.toISOString(),
    },
    inviteUrl: buildInviteUrl({
      frontendOrigin: input.frontendOrigin,
      invitationId: input.invitation.id,
      secret: input.rawSecret,
    }),
  });
}

/**
 * Authenticated Admin invitation creation. Mount at `/homes` on the v1 router.
 */
export function createInvitationsRouter(
  options: CreateInvitationsRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(createRequireAuth(options.principalResolver));
  router.use(
    '/:homeId',
    createRequireHomeContext(options.activeHomeActorResolver),
  );

  router.post('/:homeId/invitations', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const email = parseCreateInvitationBody(req.body);
      const created = await options.createInvitation({
        actor,
        homeId,
        email,
      });
      res.status(201).json(
        toCreatedInvitationDto({
          frontendOrigin: options.frontendOrigin,
          invitation: created.invitation,
          rawSecret: created.rawSecret,
        }),
      );
    })().catch(next);
  });

  router.post('/:homeId/invitations/:invitationId/revoke', (req, res, next) => {
    void (async () => {
      const actor = getActiveHomeActor(res);
      const homeId = parsePathUuid(req.params['homeId']);
      const invitationId = parsePathUuid(req.params['invitationId']);
      parseRevokeInvitationBody(req.body);
      await options.revokeInvitation({
        actor,
        homeId,
        invitationId,
      });
      res.status(204).end();
    })().catch(next);
  });

  return router;
}

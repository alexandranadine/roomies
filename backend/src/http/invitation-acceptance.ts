import { Router } from 'express';
import { z } from 'zod';
import type {
  AcceptInvitationInput,
  AcceptInvitationResult,
} from '../application/invitations/accept-invitation.js';
import {
  InvalidInvitationAuthorizationError,
  parseInvitationAuthorization,
} from '../domains/invitations/bearer.js';
import { InvitationNotAvailableError } from '../domains/invitations/errors.js';
import type { PrincipalResolver } from '../platform/auth/principal.js';
import { InvalidRequestError } from '../platform/authz/index.js';
import { parsePathUuid } from '../platform/http/path-id.js';
import {
  setPrivateNoStoreHeaders,
  stripResponseEtag,
} from '../platform/http/private-response.js';
import {
  createRequireAuth,
  type RequestWithPrincipal,
} from '../platform/http/require-auth.js';

const acceptBodySchema = z.object({}).strict();

export const invitationAcceptanceDtoSchema = z
  .object({
    membershipId: z.string().uuid(),
    homeId: z.string().uuid(),
  })
  .strict();

export type InvitationAcceptanceDto = z.infer<
  typeof invitationAcceptanceDtoSchema
>;

export type AcceptInvitationCommand = (
  input: AcceptInvitationInput,
) => Promise<AcceptInvitationResult>;

export type CreateInvitationAcceptanceRouterOptions = {
  principalResolver: Pick<PrincipalResolver, 'requirePrincipal'>;
  acceptInvitation: AcceptInvitationCommand;
};

function parseAcceptBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  if (!acceptBodySchema.safeParse(body).success) {
    throw new InvalidRequestError();
  }
}

function readAuthorizationHeader(
  header: string | string[] | undefined,
): string | undefined {
  return Array.isArray(header) ? header.join(',') : header;
}

export function createInvitationAcceptanceRouter(
  options: CreateInvitationAcceptanceRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(stripResponseEtag);
  router.use(createRequireAuth(options.principalResolver));

  router.post('/:invitationId/accept', (req, res, next) => {
    void (async () => {
      const invitationId = parsePathUuid(req.params['invitationId']);

      let secret;
      try {
        secret = parseInvitationAuthorization(
          readAuthorizationHeader(req.headers.authorization),
        );
      } catch (error) {
        if (error instanceof InvalidInvitationAuthorizationError) {
          throw new InvitationNotAvailableError();
        }
        throw error;
      }
      parseAcceptBody(req.body);

      const { principal } = req as unknown as RequestWithPrincipal;
      const accepted = await options.acceptInvitation({
        invitationId,
        userId: principal.userId,
        secret,
      });
      res.status(201).json(invitationAcceptanceDtoSchema.parse(accepted));
    })().catch(next);
  });

  return router;
}

import { Router } from 'express';
import { z } from 'zod';
import type { PreviewInvitationInput } from '../application/invitations/preview-invitation.js';
import { InvalidRequestError } from '../platform/authz/index.js';
import { parsePathUuid } from '../platform/http/path-id.js';
import {
  setPrivateNoStoreHeaders,
  stripResponseEtag,
} from '../platform/http/private-response.js';

const previewBodySchema = z.object({}).strict();

export const invitationPreviewDtoSchema = z
  .object({
    invitation: z
      .object({
        id: z.string().min(1),
        email: z.string().min(1),
        expiresAt: z.string().min(1),
        home: z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type InvitationPreviewDto = z.infer<typeof invitationPreviewDtoSchema>;

export type PreviewInvitationCommand = (
  input: PreviewInvitationInput,
) => Promise<{
  invitation: {
    id: string;
    email: string;
    expiresAt: Date;
    home: { id: string; name: string };
  };
}>;

export type CreateInvitationPreviewRouterOptions = {
  previewInvitation: PreviewInvitationCommand;
};

function parsePreviewBody(body: unknown): void {
  if (body === undefined) {
    return;
  }
  if (!previewBodySchema.safeParse(body).success) {
    throw new InvalidRequestError();
  }
}

function toPreviewDto(result: {
  invitation: {
    id: string;
    email: string;
    expiresAt: Date;
    home: { id: string; name: string };
  };
}): InvitationPreviewDto {
  return invitationPreviewDtoSchema.parse({
    invitation: {
      id: result.invitation.id,
      email: result.invitation.email,
      expiresAt: result.invitation.expiresAt.toISOString(),
      home: {
        id: result.invitation.home.id,
        name: result.invitation.home.name,
      },
    },
  });
}

function readAuthorizationHeader(
  header: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(header)) {
    return header.join(',');
  }
  return header;
}

/**
 * Invitation preview is authenticated only by the invitation bearer secret.
 * Brute-force protection is an outstanding launch security item: the platform
 * has no reusable rate-limit architecture yet. The 256-bit secret remains the
 * primary entropy control. Do not shorten it.
 *
 * Mount at `/invitations` on the v1 router. Origin enforcement stays on the
 * platform `/api/v1` mutation guard — this route does not weaken it.
 */
export function createInvitationPreviewRouter(
  options: CreateInvitationPreviewRouterOptions,
): Router {
  const router = Router();
  router.use(setPrivateNoStoreHeaders);
  router.use(stripResponseEtag);

  router.post('/:invitationId/preview', (req, res, next) => {
    void (async () => {
      const invitationId = parsePathUuid(req.params['invitationId']);
      parsePreviewBody(req.body);
      const preview = await options.previewInvitation({
        invitationId,
        authorization: readAuthorizationHeader(req.headers.authorization),
      });
      res.status(200).json(toPreviewDto(preview));
    })().catch(next);
  });

  return router;
}

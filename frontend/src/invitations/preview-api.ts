import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

export const invitationPreviewQueryKey = (invitationId: string) =>
  ['invitation-preview', invitationId] as const;

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

export function previewInvitation(input: {
  invitationId: string;
  secret: string;
  signal?: AbortSignal;
}): Promise<InvitationPreviewDto> {
  return getApiClient()
    .request<InvitationPreviewDto>({
      method: 'POST',
      path: `/api/v1/invitations/${input.invitationId}/preview`,
      body: {},
      signal: input.signal,
      headers: {
        Authorization: `Invitation ${input.secret}`,
      },
    })
    .then((body) => invitationPreviewDtoSchema.parse(body));
}

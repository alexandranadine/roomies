import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

/** POST /api/v1/homes/:homeId/invitations success body. */
export const createdInvitationSchema = z
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

export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

/** ADMIN-only invitation creation. Returns a user-shareable invite URL. */
export async function createHomeInvitation(input: {
  homeId: string;
  email: string;
  signal?: AbortSignal;
}): Promise<CreatedInvitation> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: `/api/v1/homes/${encodeURIComponent(input.homeId)}/invitations`,
    body: { email: input.email },
    signal: input.signal,
  });
  return createdInvitationSchema.parse(body);
}

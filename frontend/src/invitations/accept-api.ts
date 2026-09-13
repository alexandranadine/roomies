import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

const acceptanceSchema = z
  .object({
    membershipId: z.string().uuid(),
    homeId: z.string().uuid(),
  })
  .strict();

export type InvitationAcceptance = z.infer<typeof acceptanceSchema>;

export const homeListQueryKey = ['homes'] as const;
export const currentUserHomesQueryKey = ['current-user', 'homes'] as const;

export async function acceptInvitation(input: {
  invitationId: string;
  secret: string;
}): Promise<InvitationAcceptance> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: `/api/v1/invitations/${encodeURIComponent(input.invitationId)}/accept`,
    headers: {
      Authorization: `Invitation ${input.secret}`,
    },
    body: {},
  });
  return acceptanceSchema.parse(body);
}

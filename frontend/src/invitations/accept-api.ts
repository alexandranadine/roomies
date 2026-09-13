import { z } from 'zod';
import { currentUserHomesQueryKey } from '../homes/home-query-keys.js';
import { getApiClient } from '../platform/api/index.js';

export { currentUserHomesQueryKey };

const acceptanceSchema = z
  .object({
    membershipId: z.string().uuid(),
    homeId: z.string().uuid(),
  })
  .strict();

export type InvitationAcceptance = z.infer<typeof acceptanceSchema>;

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

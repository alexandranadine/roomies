import { getApiClient } from '../platform/api/index.js';

/** POST /api/v1/homes/:homeId/invitations/:invitationId/revoke — 204. */
export async function revokeHomeInvitation(input: {
  homeId: string;
  invitationId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await getApiClient().request<void>({
    method: 'POST',
    path: `/api/v1/homes/${encodeURIComponent(input.homeId)}/invitations/${encodeURIComponent(input.invitationId)}/revoke`,
    body: {},
    signal: input.signal,
  });
}

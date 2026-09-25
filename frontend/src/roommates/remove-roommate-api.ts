import { getApiClient } from '../platform/api/index.js';

/** POST /api/v1/homes/:homeId/memberships/:membershipId/remove — 204. */
export async function removeRoommate(input: {
  homeId: string;
  membershipId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await getApiClient().request<void>({
    method: 'POST',
    path: `/api/v1/homes/${encodeURIComponent(input.homeId)}/memberships/${encodeURIComponent(input.membershipId)}/remove`,
    body: {},
    signal: input.signal,
  });
}

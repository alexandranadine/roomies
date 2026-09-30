import { getApiClient } from '../platform/api/index.js';

/** POST /api/v1/homes/:homeId/archive-final-member — 204. */
export async function archiveFinalMemberHome(input: {
  homeId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await getApiClient().request<void>({
    method: 'POST',
    path: `/api/v1/homes/${encodeURIComponent(input.homeId)}/archive-final-member`,
    body: {},
    signal: input.signal,
  });
}

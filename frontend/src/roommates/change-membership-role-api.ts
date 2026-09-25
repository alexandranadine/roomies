import { getApiClient } from '../platform/api/index.js';

export type MembershipRole = 'ROOMMATE' | 'ADMIN';

/** PATCH /api/v1/homes/:homeId/memberships/:membershipId/role — 204. */
export async function changeMembershipRole(input: {
  homeId: string;
  membershipId: string;
  role: MembershipRole;
  signal?: AbortSignal;
}): Promise<void> {
  await getApiClient().request<void>({
    method: 'PATCH',
    path: `/api/v1/homes/${encodeURIComponent(input.homeId)}/memberships/${encodeURIComponent(input.membershipId)}/role`,
    body: { role: input.role },
    signal: input.signal,
  });
}

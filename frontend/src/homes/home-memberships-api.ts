import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

/** Active Membership row for Home-scoped PRIVATE audience picking. */
export const activeHomeMembershipSchema = z
  .object({
    membershipId: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const activeHomeMembershipsSchema = z
  .object({
    currentMembershipId: z.string().min(1),
    memberships: z.array(activeHomeMembershipSchema),
  })
  .strict();

export type ActiveHomeMembership = z.infer<typeof activeHomeMembershipSchema>;
export type ActiveHomeMemberships = z.infer<typeof activeHomeMembershipsSchema>;

/** GET /api/v1/homes/:homeId/memberships */
export async function listHomeMemberships(
  homeId: string,
  signal?: AbortSignal,
): Promise<ActiveHomeMemberships> {
  const body = await getApiClient().request<unknown>({
    path: `/api/v1/homes/${encodeURIComponent(homeId)}/memberships`,
    signal,
  });
  return activeHomeMembershipsSchema.parse(body);
}

import { z } from 'zod';
import type { ActiveHomeMembershipListItem } from './active-home-membership-list.js';

/** Explicit GET /homes/:homeId/memberships row whitelist. */
export const activeHomeMembershipDtoSchema = z
  .object({
    membershipId: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

/**
 * Collection whitelist. currentMembershipId is the authenticated Home-context
 * tenure so the picker can identify self without an isSelf row flag.
 */
export const activeHomeMembershipsDtoSchema = z
  .object({
    currentMembershipId: z.string().min(1),
    memberships: z.array(activeHomeMembershipDtoSchema),
  })
  .strict();

export type ActiveHomeMembershipDto = z.infer<
  typeof activeHomeMembershipDtoSchema
>;
export type ActiveHomeMembershipsDto = z.infer<
  typeof activeHomeMembershipsDtoSchema
>;

export function toActiveHomeMembershipsDto(input: {
  currentMembershipId: string;
  memberships: readonly ActiveHomeMembershipListItem[];
}): ActiveHomeMembershipsDto {
  return activeHomeMembershipsDtoSchema.parse({
    currentMembershipId: input.currentMembershipId,
    memberships: input.memberships.map((row) => ({
      membershipId: row.membershipId,
      name: row.name,
    })),
  });
}

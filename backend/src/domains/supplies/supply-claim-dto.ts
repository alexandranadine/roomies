import { z } from 'zod';
import type { SupplyClaim } from './supply.js';

/** Explicit claim-success whitelist. No Home, user, or persistence internals. */
export const supplyClaimDtoSchema = z
  .object({
    id: z.string().min(1),
    supplyEntryId: z.string().min(1),
    claimantMembershipId: z.string().min(1),
    claimedAt: z.string().min(1),
    releasedAt: z.null(),
    releaseReason: z.null(),
  })
  .strict();

export type SupplyClaimDto = z.infer<typeof supplyClaimDtoSchema>;

export function toSupplyClaimDto(claim: SupplyClaim): SupplyClaimDto {
  return supplyClaimDtoSchema.parse({
    id: claim.id,
    supplyEntryId: claim.supplyEntryId,
    claimantMembershipId: claim.claimantMembershipId,
    claimedAt: claim.claimedAt.toISOString(),
    releasedAt: null,
    releaseReason: null,
  });
}

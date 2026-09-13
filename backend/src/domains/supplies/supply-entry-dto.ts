import { z } from 'zod';
import type {
  ActiveSupplyClaimProjection,
  ListedSupplyEntry,
  SupplyEntry,
} from './supply.js';

const supplyActiveClaimDtoSchema = z
  .object({
    claimantMembershipId: z.string().min(1),
    claimedAt: z.string().min(1),
  })
  .strict();

/** Explicit create/list whitelist. Active claim projection only; no claim id. */
export const supplyEntryDtoSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(['OPEN', 'OBTAINED', 'CANCELED']),
    createdByMembershipId: z.string().min(1),
    obtainedAt: z.string().min(1).nullable(),
    canceledAt: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    activeClaim: supplyActiveClaimDtoSchema.nullable(),
  })
  .strict();

export type SupplyEntryDto = z.infer<typeof supplyEntryDtoSchema>;

export const supplyEntryListDtoSchema = z.array(supplyEntryDtoSchema);

export type SupplyEntryListDto = z.infer<typeof supplyEntryListDtoSchema>;

function toActiveClaimDto(
  activeClaim: ActiveSupplyClaimProjection | null,
): SupplyEntryDto['activeClaim'] {
  if (activeClaim === null) {
    return null;
  }
  return {
    claimantMembershipId: activeClaim.claimantMembershipId,
    claimedAt: activeClaim.claimedAt.toISOString(),
  };
}

export function toSupplyEntryDto(
  entry: SupplyEntry,
  activeClaim: ActiveSupplyClaimProjection | null = null,
): SupplyEntryDto {
  return supplyEntryDtoSchema.parse({
    id: entry.id,
    title: entry.title,
    status: entry.status,
    createdByMembershipId: entry.createdByMembershipId,
    obtainedAt:
      entry.obtainedAt === null ? null : entry.obtainedAt.toISOString(),
    canceledAt:
      entry.canceledAt === null ? null : entry.canceledAt.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    activeClaim: toActiveClaimDto(activeClaim),
  });
}

export function toSupplyEntryListDto(
  entries: readonly ListedSupplyEntry[],
): SupplyEntryListDto {
  return supplyEntryListDtoSchema.parse(
    entries.map((entry) => toSupplyEntryDto(entry, entry.activeClaim)),
  );
}

import { z } from 'zod';
import type { SupplyEntry } from './supply.js';

/** Explicit create/list whitelist. No Home internals or claim state. */
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
  })
  .strict();

export type SupplyEntryDto = z.infer<typeof supplyEntryDtoSchema>;

export const supplyEntryListDtoSchema = z.array(supplyEntryDtoSchema);

export type SupplyEntryListDto = z.infer<typeof supplyEntryListDtoSchema>;

export function toSupplyEntryDto(entry: SupplyEntry): SupplyEntryDto {
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
  });
}

export function toSupplyEntryListDto(
  entries: readonly SupplyEntry[],
): SupplyEntryListDto {
  return supplyEntryListDtoSchema.parse(entries.map(toSupplyEntryDto));
}

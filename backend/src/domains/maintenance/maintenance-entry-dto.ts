import { z } from 'zod';
import type {
  MaintenanceDetailProjection,
  MaintenanceListItemProjection,
} from './maintenance.js';

export const maintenanceListItemDtoSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.enum(['OPEN', 'RESOLVED']),
    visibility: z.enum(['HOUSEHOLD', 'PRIVATE']),
    createdByMembershipId: z.string().min(1),
    resolvedByMembershipId: z.string().min(1).nullable(),
    resolvedAt: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type MaintenanceListItemDto = z.infer<
  typeof maintenanceListItemDtoSchema
>;

export const maintenanceDetailDtoSchema = maintenanceListItemDtoSchema
  .extend({
    details: z.string().min(1).nullable(),
  })
  .strict();

export type MaintenanceDetailDto = z.infer<typeof maintenanceDetailDtoSchema>;

export const maintenanceListPageDtoSchema = z
  .object({
    items: z.array(maintenanceListItemDtoSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type MaintenanceListPageDto = z.infer<
  typeof maintenanceListPageDtoSchema
>;

export function toMaintenanceListItemDto(
  entry: MaintenanceListItemProjection,
): MaintenanceListItemDto {
  return maintenanceListItemDtoSchema.parse({
    id: entry.id,
    title: entry.title,
    status: entry.status,
    visibility: entry.visibility,
    createdByMembershipId: entry.createdByMembershipId,
    resolvedByMembershipId: entry.resolvedByMembershipId,
    resolvedAt:
      entry.resolvedAt === null ? null : entry.resolvedAt.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  });
}

export function toMaintenanceDetailDto(
  entry: MaintenanceDetailProjection,
): MaintenanceDetailDto {
  return maintenanceDetailDtoSchema.parse({
    ...toMaintenanceListItemDto(entry),
    details: entry.details,
  });
}

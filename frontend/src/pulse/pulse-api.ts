import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

const HOME_LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const sectionStateSchema = z.enum(['CLEAR', 'ACTIVE']);

export const taskPulseItemSchema = z
  .object({
    type: z.literal('TASKS'),
    state: sectionStateSchema,
    assignedOpenCount: z.number().int().nonnegative(),
    unassignedOpenCount: z.number().int().nonnegative(),
    dueTodayRelevantCount: z.number().int().nonnegative(),
    overdueRelevantCount: z.number().int().nonnegative(),
  })
  .strict();

export const supplyPulseItemSchema = z
  .object({
    type: z.literal('SUPPLIES'),
    state: sectionStateSchema,
    openCount: z.number().int().nonnegative(),
    unclaimedOpenCount: z.number().int().nonnegative(),
    claimedByMeCount: z.number().int().nonnegative(),
  })
  .strict();

export const maintenancePulseItemSchema = z
  .object({
    type: z.literal('MAINTENANCE'),
    state: sectionStateSchema,
    openVisibleCount: z.number().int().nonnegative(),
  })
  .strict();

/** Exact M7.5 House Pulse DTO whitelist. No entity IDs or protected content. */
export const housePulseDtoSchema = z
  .object({
    generatedAt: z.string().min(1),
    homeLocalDate: z.string().regex(HOME_LOCAL_DATE_PATTERN),
    items: z.tuple([
      taskPulseItemSchema,
      supplyPulseItemSchema,
      maintenancePulseItemSchema,
    ]),
  })
  .strict();

export type TaskPulseItem = z.infer<typeof taskPulseItemSchema>;
export type SupplyPulseItem = z.infer<typeof supplyPulseItemSchema>;
export type MaintenancePulseItem = z.infer<typeof maintenancePulseItemSchema>;
export type HousePulseDto = z.infer<typeof housePulseDtoSchema>;
export type HousePulseSectionState = z.infer<typeof sectionStateSchema>;

/** GET /api/v1/homes/:homeId/pulse */
export async function getHousePulse(
  homeId: string,
  signal?: AbortSignal,
): Promise<HousePulseDto> {
  const body = await getApiClient().request<unknown>({
    path: `/api/v1/homes/${encodeURIComponent(homeId)}/pulse`,
    signal,
  });
  return housePulseDtoSchema.parse(body);
}

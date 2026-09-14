import { z } from 'zod';
import { HOME_LOCAL_DATE_PATTERN } from '../tasks/home-local-date.js';
import type { HousePulse } from './house-pulse.js';

const sectionStateSchema = z.enum(['CLEAR', 'ACTIVE']);

export const taskPulseItemDtoSchema = z
  .object({
    type: z.literal('TASKS'),
    state: sectionStateSchema,
    assignedOpenCount: z.number().int().nonnegative(),
    unassignedOpenCount: z.number().int().nonnegative(),
    dueTodayRelevantCount: z.number().int().nonnegative(),
    overdueRelevantCount: z.number().int().nonnegative(),
  })
  .strict();

export const supplyPulseItemDtoSchema = z
  .object({
    type: z.literal('SUPPLIES'),
    state: sectionStateSchema,
    openCount: z.number().int().nonnegative(),
    unclaimedOpenCount: z.number().int().nonnegative(),
    claimedByMeCount: z.number().int().nonnegative(),
  })
  .strict();

export const maintenancePulseItemDtoSchema = z
  .object({
    type: z.literal('MAINTENANCE'),
    state: sectionStateSchema,
    openVisibleCount: z.number().int().nonnegative(),
  })
  .strict();

/** Explicit Pulse whitelist. No entity IDs, names, or protected content. */
export const housePulseDtoSchema = z
  .object({
    generatedAt: z.string().min(1),
    homeLocalDate: z.string().regex(HOME_LOCAL_DATE_PATTERN),
    items: z.tuple([
      taskPulseItemDtoSchema,
      supplyPulseItemDtoSchema,
      maintenancePulseItemDtoSchema,
    ]),
  })
  .strict();

export type HousePulseDto = z.infer<typeof housePulseDtoSchema>;

export function toHousePulseDto(pulse: HousePulse): HousePulseDto {
  return housePulseDtoSchema.parse({
    generatedAt: pulse.generatedAt.toISOString(),
    homeLocalDate: pulse.homeLocalDate,
    items: pulse.items,
  });
}

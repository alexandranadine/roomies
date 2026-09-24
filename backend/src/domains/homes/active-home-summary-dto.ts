import { z } from 'zod';
import { MEMBERSHIP_ROLES } from '../../platform/authz/context.js';
import type { ActiveHomeSummary } from './active-home-summary.js';

/** Explicit GET /me/homes row whitelist. No Membership id, archive, or object-key fields. */
export const activeHomeSummaryDtoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    timezone: z.string().min(1),
    role: z.enum(MEMBERSHIP_ROLES),
    hasPhoto: z.boolean(),
  })
  .strict();

export const activeHomesDtoSchema = z.array(activeHomeSummaryDtoSchema);

export type ActiveHomeSummaryDto = z.infer<typeof activeHomeSummaryDtoSchema>;

export function toActiveHomeSummaryDto(
  home: ActiveHomeSummary,
): ActiveHomeSummaryDto {
  return activeHomeSummaryDtoSchema.parse({
    id: home.id,
    name: home.name,
    timezone: home.timezone,
    role: home.role,
    hasPhoto: home.photoObjectKey !== null,
  });
}

export function toActiveHomesDto(
  homes: readonly ActiveHomeSummary[],
): ActiveHomeSummaryDto[] {
  return activeHomesDtoSchema.parse(homes.map(toActiveHomeSummaryDto));
}

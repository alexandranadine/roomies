import { z } from 'zod';
import type { Home } from './home.js';

/** Explicit GET /homes/:homeId whitelist. No Membership, role, or archive fields. */
export const homeDtoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    timezone: z.string().min(1),
  })
  .strict();

export type HomeDto = z.infer<typeof homeDtoSchema>;

export function toHomeDto(home: Home): HomeDto {
  return homeDtoSchema.parse({
    id: home.id,
    name: home.name,
    timezone: home.timezone,
  });
}

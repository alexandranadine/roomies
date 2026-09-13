import { z } from 'zod';
import { homeDtoSchema, toHomeDto } from './home-dto.js';
import type { Home } from './home.js';

/** Explicit POST /homes whitelist. No archive or tenure timestamps. */
export const createdHomeDtoSchema = z
  .object({
    home: homeDtoSchema,
    membership: z
      .object({
        id: z.string().min(1),
        role: z.literal('ADMIN'),
      })
      .strict(),
  })
  .strict();

export type CreatedHomeDto = z.infer<typeof createdHomeDtoSchema>;

export function toCreatedHomeDto(input: {
  home: Home;
  membership: Readonly<{ id: string; role: 'ADMIN' }>;
}): CreatedHomeDto {
  return createdHomeDtoSchema.parse({
    home: toHomeDto(input.home),
    membership: {
      id: input.membership.id,
      role: 'ADMIN',
    },
  });
}

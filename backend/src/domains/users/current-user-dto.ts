import { z } from 'zod';
import type { CurrentUser } from './current-user.js';

/** Explicit `/api/v1/me` whitelist. No timestamps, auth, or membership fields. */
export const currentUserDtoSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export type CurrentUserDto = z.infer<typeof currentUserDtoSchema>;

export function toCurrentUserDto(user: CurrentUser): CurrentUserDto {
  return currentUserDtoSchema.parse({ id: user.id });
}

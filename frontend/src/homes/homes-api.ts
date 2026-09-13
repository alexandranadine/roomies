import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

export const activeHomeRoleSchema = z.enum(['ROOMMATE', 'ADMIN']);

const activeHomeSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    timezone: z.string().min(1),
    role: activeHomeRoleSchema,
  })
  .strict();

const activeHomesSchema = z.array(activeHomeSchema);

export type ActiveHome = z.infer<typeof activeHomeSchema>;

export async function listCurrentUserHomes(
  signal?: AbortSignal,
): Promise<readonly ActiveHome[]> {
  const body = await getApiClient().request<unknown>({
    path: '/api/v1/me/homes',
    signal,
  });
  return activeHomesSchema.parse(body);
}

import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

const createdHomeSchema = z
  .object({
    home: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        timezone: z.string().min(1),
      })
      .strict(),
    membership: z
      .object({
        id: z.string().uuid(),
        role: z.literal('ADMIN'),
      })
      .strict(),
  })
  .strict();

export type CreatedHome = z.infer<typeof createdHomeSchema>;

export async function createHome(input: {
  name: string;
  timezone: string;
}): Promise<CreatedHome> {
  const body = await getApiClient().request<unknown>({
    method: 'POST',
    path: '/api/v1/homes',
    body: {
      name: input.name,
      timezone: input.timezone,
    },
  });
  return createdHomeSchema.parse(body);
}

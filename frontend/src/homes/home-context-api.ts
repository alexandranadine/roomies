import { z } from 'zod';
import { getApiClient } from '../platform/api/index.js';

const homeContextSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    timezone: z.string().min(1),
  })
  .strict();

export type HomeContext = z.infer<typeof homeContextSchema>;

export async function getHomeContext(
  homeId: string,
  signal?: AbortSignal,
): Promise<HomeContext> {
  const body = await getApiClient().request<unknown>({
    path: `/api/v1/homes/${encodeURIComponent(homeId)}`,
    signal,
  });
  return homeContextSchema.parse(body);
}

import { z } from 'zod';
import { InvalidPathInputError } from '../authz/errors.js';

/**
 * PostgreSQL uuid text form. Accepts the UUID versions Roomies actually
 * stores: Better Auth / auth-provisioned User IDs (v4) and domain IDs (v7).
 * Version-narrow helpers would reject one of those populations.
 */
export const PATH_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const pathUuidSchema = z.string().regex(PATH_UUID_PATTERN);

export function parsePathUuid(value: unknown): string {
  const parsed = pathUuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidPathInputError();
  }
  return parsed.data;
}

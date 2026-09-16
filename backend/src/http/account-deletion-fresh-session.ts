import { UnauthenticatedError } from '../platform/auth/errors.js';
import type { Clock } from '../platform/time/clock.js';

/** Account deletion requires a server-side session no older than 5 minutes. */
export const ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Freshness uses injected Clock.now() minus authoritative session.createdAt.
 *
 * - age <= 5 minutes → fresh
 * - age > 5 minutes → stale
 * - createdAt in the future (age < 0) → fail closed (stale)
 *
 * No clock-skew tolerance is applied. A 1ms future timestamp is stale.
 */
export function isFreshAccountDeletionSession(
  sessionCreatedAt: Date,
  now: Date,
): boolean {
  const ageMs = now.getTime() - sessionCreatedAt.getTime();
  if (Number.isNaN(ageMs) || ageMs < 0) {
    return false;
  }
  return ageMs <= ACCOUNT_DELETION_FRESH_SESSION_MAX_AGE_MS;
}

export function requireFreshAccountDeletionSession(
  sessionCreatedAt: Date | undefined,
  clock: Clock,
): void {
  if (
    !(sessionCreatedAt instanceof Date) ||
    Number.isNaN(sessionCreatedAt.getTime())
  ) {
    throw new UnauthenticatedError();
  }
  if (!isFreshAccountDeletionSession(sessionCreatedAt, clock.now())) {
    throw new UnauthenticatedError();
  }
}

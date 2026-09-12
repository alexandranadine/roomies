import type { CurrentUser } from './current-user.js';

/**
 * Map an authenticated principal to the current User.
 *
 * `principal.userId` is the canonical User id. Principal resolution already
 * enforces the User-row invariant, so this use case does not re-query
 * persistence solely to re-prove existence.
 */
export function getCurrentUser(principal: { userId: string }): CurrentUser {
  return { id: principal.userId };
}

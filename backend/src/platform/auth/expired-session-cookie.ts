import { expiredAuthSessionSetCookie as createExpiredAuthSessionSetCookie } from '../../../auth-runtime/src/expired-session-cookie.js';
import type { AuthRuntime } from './runtime.js';

export type AuthSessionCookieCommitOutcome = 'committed' | 'aborted';

/**
 * Set-Cookie that expires the Roomies Better Auth session cookie.
 * Name and attributes come from the live runtime via Better Auth getCookies.
 * Does not mutate the database. Invoke only after the application transaction
 * has committed.
 */
export function expiredAuthSessionSetCookie(auth: AuthRuntime): string {
  return createExpiredAuthSessionSetCookie(auth);
}

/**
 * Post-commit HTTP boundary for future account deletion. A rolled-back or
 * failed mutation must pass `aborted` so the client's valid session cookie
 * is left untouched.
 */
export function appendExpiredAuthSessionCookieAfterCommit(
  headers: { append(name: string, value: string): void },
  outcome: AuthSessionCookieCommitOutcome,
  auth: AuthRuntime,
): void {
  if (outcome !== 'committed') {
    return;
  }
  headers.append('Set-Cookie', expiredAuthSessionSetCookie(auth));
}

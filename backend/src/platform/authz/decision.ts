/**
 * Shared authorization decision primitive. Denial reasons are backend-only
 * diagnostics and must never be written to HTTP responses.
 */
export type AuthorizationDecision<Reason extends string> =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: Reason };

export function allow<
  Reason extends string = never,
>(): AuthorizationDecision<Reason> {
  return { allowed: true };
}

export function deny<Reason extends string>(
  reason: Reason,
): AuthorizationDecision<Reason> {
  return { allowed: false, reason };
}

import type { MembershipRole } from '../../platform/authz/context.js';

export type HomeStructureInvariantInput = Readonly<{
  archived: boolean;
  activeMemberships: readonly { role: MembershipRole }[];
}>;

export type HomeStructureInvariantDenial = 'ACTIVE_HOME_WITHOUT_ADMIN';

export type HomeStructureInvariantResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: HomeStructureInvariantDenial };

/**
 * Frozen structural invariant:
 * IF a Home is non-archived AND it has at least one active Membership
 * THEN at least one of those Memberships must be ADMIN.
 *
 * A non-archived Home with zero active Memberships is not a valid normal
 * Roomies product state, but it does not violate this implication. The
 * actor-bound lock kernel never returns that snapshot: an empty active set
 * means the exact actor tenure is gone and is concealed as NOT_FOUND.
 * This evaluator therefore treats empty-active + non-archived as vacuously
 * valid and does not archive, promote, or repair.
 */
export function evaluateHomeStructureInvariant(
  input: HomeStructureInvariantInput,
): HomeStructureInvariantResult {
  if (input.archived || input.activeMemberships.length === 0) {
    return { ok: true };
  }

  const activeAdminCount = input.activeMemberships.filter(
    (membership) => membership.role === 'ADMIN',
  ).length;

  if (activeAdminCount < 1) {
    return { ok: false, reason: 'ACTIVE_HOME_WITHOUT_ADMIN' };
  }

  return { ok: true };
}

/** Visible conflict: an Admin may archive only as the final active member. */
export class FinalMemberRequiredError extends Error {
  override readonly name = 'FinalMemberRequiredError';
  readonly code = 'FINAL_MEMBER_REQUIRED';

  constructor() {
    super('Final member required');
  }
}

/**
 * House Pulse Home snapshot could not be read safely.
 * Messages never include Home names, Membership IDs, or user identity.
 */
export class HousePulseSnapshotIntegrityError extends Error {
  override readonly name = 'HousePulseSnapshotIntegrityError';

  constructor() {
    super('House pulse snapshot integrity failure');
  }
}

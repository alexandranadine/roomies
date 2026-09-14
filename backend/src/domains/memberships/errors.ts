/**
 * Visible structural conflict: an authorized role change would leave an
 * active Home with no active Admin. Not a transaction or authz integrity error.
 */
export class LastAdminRequiredError extends Error {
  override readonly name = 'LastAdminRequiredError';
  readonly code = 'LAST_ADMIN_REQUIRED';

  constructor() {
    super('Last admin required');
  }
}

/**
 * Visible structural conflict: ordinary leave of the sole valid active
 * Membership is forbidden. The later explicit final-member archive is required.
 * Not an auto-archive and not last-Admin conflict.
 */
export class LastRoommateRequiresArchiveError extends Error {
  override readonly name = 'LastRoommateRequiresArchiveError';
  readonly code = 'LAST_ROOMMATE_REQUIRES_ARCHIVE';

  constructor() {
    super('Last roommate requires archive');
  }
}

/**
 * Canonical Membership Activity source could not be read safely.
 * Messages never include user identifiers, names, email, or roles.
 */
export class MembershipActivitySourceIntegrityError extends Error {
  override readonly name = 'MembershipActivitySourceIntegrityError';

  constructor() {
    super('Membership activity source integrity failure');
  }
}

export class InvitationPersistenceError extends Error {
  constructor() {
    super('Invitation persistence operation failed');
    this.name = 'InvitationPersistenceError';
  }
}

export class InvitationValidityConflictError extends Error {
  constructor() {
    super('An effective invitation already exists');
    this.name = 'InvitationValidityConflictError';
  }
}

/**
 * Visible Admin-only conflict: the same Home already has an effective pending
 * invitation for the same normalized email. Not a persistence-integrity signal.
 */
export class InvitationAlreadyPendingError extends Error {
  override readonly name = 'InvitationAlreadyPendingError';
  readonly code = 'INVITATION_ALREADY_PENDING';

  constructor() {
    super('Invitation already pending');
  }
}

/**
 * Visible Admin-only conflict: the invited identity already has an active
 * Membership in the locked Home.
 */
export class AlreadyHomeMemberError extends Error {
  override readonly name = 'AlreadyHomeMemberError';
  readonly code = 'ALREADY_HOME_MEMBER';

  constructor() {
    super('Already a home member');
  }
}

/**
 * Uniform external failure for invitation preview. Same contract for unknown
 * IDs, invalid tokens, and non-pending lifecycle — not an existence oracle.
 */
export class InvitationNotAvailableError extends Error {
  override readonly name = 'InvitationNotAvailableError';
  readonly code = 'INVITATION_NOT_AVAILABLE';

  constructor() {
    super('Invitation is not available');
  }
}

export class InvitationEmailMismatchError extends Error {
  override readonly name = 'InvitationEmailMismatchError';
  readonly code = 'EMAIL_MISMATCH';

  constructor() {
    super('Current verified email does not match the invitation recipient');
  }
}

export class InvitationEmailNotVerifiedError extends Error {
  override readonly name = 'InvitationEmailNotVerifiedError';
  readonly code = 'EMAIL_NOT_VERIFIED';

  constructor() {
    super('Current email is not verified');
  }
}

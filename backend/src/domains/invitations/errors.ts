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

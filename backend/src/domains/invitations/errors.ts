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

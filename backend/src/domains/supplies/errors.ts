export class InvalidSupplyTitleError extends Error {
  override readonly name = 'InvalidSupplyTitleError';

  constructor() {
    super('Invalid Supply title');
  }
}

export class SupplyPersistenceError extends Error {
  override readonly name = 'SupplyPersistenceError';

  constructor() {
    super('Supply persistence failure');
  }
}

export class SupplyPersistenceError extends Error {
  override readonly name = 'SupplyPersistenceError';

  constructor() {
    super('Supply persistence failure');
  }
}

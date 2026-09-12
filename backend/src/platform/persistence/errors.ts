/**
 * Safe transaction-lifecycle failure. Messages never include SQL, hosts,
 * database names, or driver details.
 */
export class TransactionInfrastructureError extends Error {
  override readonly name = 'TransactionInfrastructureError';

  constructor() {
    super('Transaction infrastructure failure');
  }
}

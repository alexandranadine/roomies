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

/**
 * Visible state conflict: an OPEN SupplyEntry already has an active claim.
 * Repeating the same claimant is the same conflict. Not an identity leak.
 */
export class SupplyAlreadyClaimedError extends Error {
  override readonly name = 'SupplyAlreadyClaimedError';
  readonly code = 'SUPPLY_ALREADY_CLAIMED';

  constructor() {
    super('Supply already claimed');
  }
}

/**
 * Visible state conflict: claim is allowed only while the SupplyEntry is OPEN.
 */
export class SupplyNotOpenError extends Error {
  override readonly name = 'SupplyNotOpenError';
  readonly code = 'SUPPLY_NOT_OPEN';

  constructor() {
    super('Supply is not open');
  }
}

/**
 * Visible state conflict: manual release requires one active claim.
 * Repeated release and released-history-only are the same conflict.
 */
export class SupplyClaimNotActiveError extends Error {
  override readonly name = 'SupplyClaimNotActiveError';
  readonly code = 'SUPPLY_CLAIM_NOT_ACTIVE';

  constructor() {
    super('Supply claim is not active');
  }
}

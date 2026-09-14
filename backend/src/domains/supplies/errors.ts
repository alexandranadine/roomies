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

/**
 * Canonical Supply Activity source could not be read safely.
 * Messages never include title, claimant, creator, Home, or Membership IDs.
 */
export class SupplyActivitySourceIntegrityError extends Error {
  override readonly name = 'SupplyActivitySourceIntegrityError';

  constructor() {
    super('Supply activity source integrity failure');
  }
}

/**
 * Canonical Supply Notification source could not be read safely.
 * Messages never include title, claimant, creator, Home, or Membership IDs.
 */
export class SupplyNotificationSourceIntegrityError extends Error {
  override readonly name = 'SupplyNotificationSourceIntegrityError';

  constructor() {
    super('Supply notification source integrity failure');
  }
}

/**
 * House Pulse Supply summary could not be read safely.
 * Messages never include titles, claimants, Home, or Membership IDs.
 */
export class SupplyPulseSummaryIntegrityError extends Error {
  override readonly name = 'SupplyPulseSummaryIntegrityError';

  constructor() {
    super('Supply pulse summary integrity failure');
  }
}

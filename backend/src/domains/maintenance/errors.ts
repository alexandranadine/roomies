export class InvalidMaintenanceTitleError extends Error {
  override readonly name = 'InvalidMaintenanceTitleError';

  constructor() {
    super('Invalid Maintenance title');
  }
}

export class InvalidMaintenanceDetailsError extends Error {
  override readonly name = 'InvalidMaintenanceDetailsError';

  constructor() {
    super('Invalid Maintenance details');
  }
}

export class InvalidMaintenanceRequestError extends Error {
  override readonly name = 'InvalidMaintenanceRequestError';
  readonly code = 'INVALID_REQUEST';

  constructor() {
    super('Invalid request');
  }
}

export class MaintenancePersistenceError extends Error {
  override readonly name = 'MaintenancePersistenceError';

  constructor() {
    super('Maintenance persistence failure');
  }
}

/**
 * Canonical Maintenance Activity source could not be read safely.
 * Messages never include title, details, audience, Home, or Membership IDs.
 */
export class MaintenanceActivitySourceIntegrityError extends Error {
  override readonly name = 'MaintenanceActivitySourceIntegrityError';

  constructor() {
    super('Maintenance activity source integrity failure');
  }
}

/**
 * Visible state conflict: resolve is allowed only while the entry is OPEN.
 * Returned only after the entry is proven visible.
 */
export class MaintenanceNotOpenError extends Error {
  override readonly name = 'MaintenanceNotOpenError';
  readonly code = 'MAINTENANCE_NOT_OPEN';

  constructor() {
    super('Maintenance is not open');
  }
}

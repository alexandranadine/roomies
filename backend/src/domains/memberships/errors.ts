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

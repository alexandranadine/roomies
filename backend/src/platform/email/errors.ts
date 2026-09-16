/**
 * Transactional mail delivery failed. Safe for HTTP mapping: no provider
 * bodies, emails, tokens, or verification URLs.
 */
export class TransactionalEmailDeliveryError extends Error {
  override readonly name = 'TransactionalEmailDeliveryError';
  readonly status = 500;
  readonly code = 'INTERNAL_ERROR';

  constructor() {
    super('Email delivery failed');
  }
}

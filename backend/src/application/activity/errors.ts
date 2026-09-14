/**
 * Stable Activity projection integrity failure. Messages never include
 * source title, details, audience, payload, Home, or Membership IDs.
 */
export class ActivityProjectionIntegrityError extends Error {
  override readonly name = 'ActivityProjectionIntegrityError';

  constructor() {
    super('Activity projection integrity failure');
  }
}

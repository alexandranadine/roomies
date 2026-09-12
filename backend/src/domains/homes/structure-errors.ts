/**
 * Frozen Home/Membership structural state is impossible. Messages never
 * include SQL, Home IDs, Membership IDs, or roles.
 */
export class StructuralIntegrityError extends Error {
  override readonly name = 'StructuralIntegrityError';

  constructor() {
    super('Home structure integrity failure');
  }
}

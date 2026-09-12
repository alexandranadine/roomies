/** Visible conflict: an Admin may archive only as the final active member. */
export class FinalMemberRequiredError extends Error {
  override readonly name = 'FinalMemberRequiredError';
  readonly code = 'FINAL_MEMBER_REQUIRED';

  constructor() {
    super('Final member required');
  }
}

import type { MembershipEndingTaskCleanup } from './membership-ending-cleanup.js';

/**
 * TEMPORARY no-op Task cleanup for membership ending.
 *
 * Task persistence tables now exist. The real Membership-ending Task cleanup
 * is not implemented yet; this adapter intentionally remains a no-op until
 * that Task application behavior is implemented. The orchestrator always
 * invokes the Task port; composition injects this implementation explicitly —
 * it is not an optional callback.
 *
 * Acquires no connection, issues no SQL, and writes no events.
 */
export function createTemporaryNoOpMembershipEndingTaskCleanup(): MembershipEndingTaskCleanup {
  return Object.freeze({
    handleMembershipEnded() {
      return Promise.resolve();
    },
  });
}

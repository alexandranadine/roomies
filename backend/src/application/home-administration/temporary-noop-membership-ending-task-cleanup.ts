import type { MembershipEndingTaskCleanup } from './membership-ending-cleanup.js';

/**
 * TEMPORARY no-op Task cleanup for membership ending.
 *
 * Tasks tables and the Tasks module do not exist yet. This adapter MUST be
 * replaced when M3 Tasks ships. The orchestrator always invokes the Task
 * port; composition injects this implementation explicitly — it is not an
 * optional callback.
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

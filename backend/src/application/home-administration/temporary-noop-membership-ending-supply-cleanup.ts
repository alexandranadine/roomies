import type { MembershipEndingSupplyCleanup } from './membership-ending-cleanup.js';

/**
 * TEMPORARY no-op Supply cleanup for membership ending.
 *
 * Supplies tables and the Supplies module do not exist yet. This adapter
 * MUST be replaced when M4 Supplies ships. The orchestrator always invokes
 * the Supply port; composition injects this implementation explicitly — it
 * is not an optional callback.
 *
 * Acquires no connection, issues no SQL, and writes no events.
 */
export function createTemporaryNoOpMembershipEndingSupplyCleanup(): MembershipEndingSupplyCleanup {
  return Object.freeze({
    handleMembershipEnded() {
      return Promise.resolve();
    },
  });
}

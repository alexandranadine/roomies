import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MembershipEndedCause } from '../../domains/memberships/events.js';
import type { ReleaseMembershipClaims } from '../../domains/supplies/repository.js';
import type { SupplyClaimReleaseReason } from '../../domains/supplies/supply.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createMembershipEndingSupplyCleanup,
  type MembershipEndingSupplyCleanupSupplies,
} from './membership-ending-supply-cleanup.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REJOINED_MEMBERSHIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');
const CLAIMED_AT = new Date('2026-03-01T00:00:00.000Z');
const PREVIOUSLY_RELEASED_AT = new Date('2026-03-10T00:00:00.000Z');
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('cleanup must use repository methods')),
};

type EntryRow = {
  id: string;
  homeId: string;
  title: string;
  status: 'OPEN' | 'OBTAINED' | 'CANCELED';
  createdByMembershipId: string;
  updatedAt: Date;
};

type ClaimRow = {
  id: string;
  homeId: string;
  supplyEntryId: string;
  claimantMembershipId: string;
  claimedAt: Date;
  releasedAt: Date | null;
  releaseReason: SupplyClaimReleaseReason | null;
  createdAt: Date;
  updatedAt: Date;
};

function entry(overrides: Partial<EntryRow> & Pick<EntryRow, 'id'>): EntryRow {
  return {
    homeId: HOME,
    title: 'Paper towels',
    status: 'OPEN',
    createdByMembershipId: OTHER_MEMBERSHIP,
    updatedAt: CLAIMED_AT,
    ...overrides,
  };
}

function claim(
  overrides: Partial<ClaimRow> & Pick<ClaimRow, 'id' | 'supplyEntryId'>,
): ClaimRow {
  return {
    homeId: HOME,
    claimantMembershipId: MEMBERSHIP,
    claimedAt: CLAIMED_AT,
    releasedAt: null,
    releaseReason: null,
    createdAt: CLAIMED_AT,
    updatedAt: CLAIMED_AT,
    ...overrides,
  };
}

function storeOf(input: { entries?: EntryRow[]; claims?: ClaimRow[] }) {
  const entries = input.entries ?? [];
  const claims = input.claims ?? [];
  const calls: ReleaseMembershipClaims[] = [];
  const supplies: MembershipEndingSupplyCleanupSupplies = {
    releaseActiveClaimsForMembership(_tx, assignment) {
      calls.push(assignment);
      let updated = 0;
      for (const row of claims) {
        if (
          row.homeId === assignment.homeId &&
          row.claimantMembershipId === assignment.membershipId &&
          row.releasedAt === null
        ) {
          row.releasedAt = assignment.releasedAt;
          row.releaseReason = 'MEMBERSHIP_ENDED';
          row.updatedAt = assignment.releasedAt;
          updated += 1;
        }
      }
      return Promise.resolve(updated);
    },
  };
  return {
    entries,
    claims,
    calls,
    cleanup: createMembershipEndingSupplyCleanup(supplies),
  };
}

async function endExactTenure(
  store: ReturnType<typeof storeOf>,
  cause: MembershipEndedCause = 'VOLUNTARY_LEAVE',
): Promise<void> {
  await store.cleanup.handleMembershipEnded(TX, {
    homeId: HOME,
    membershipId: MEMBERSHIP,
    endedAt: ENDED_AT,
    cause,
  });
}

void describe('membership-ending Supply cleanup application seam', () => {
  void it('ending Membership with no active Supply claims succeeds', async () => {
    const store = storeOf({});
    await endExactTenure(store);
    assert.equal(store.calls.length, 1);
    assert.deepEqual(store.calls[0], {
      homeId: HOME,
      membershipId: MEMBERSHIP,
      releasedAt: ENDED_AT,
    });
    assert.deepEqual(store.claims, []);
  });

  void it('releases one active claim with MEMBERSHIP_ENDED', async () => {
    const store = storeOf({
      entries: [entry({ id: 'entry-one' })],
      claims: [claim({ id: 'claim-one', supplyEntryId: 'entry-one' })],
    });
    await endExactTenure(store);
    assert.equal(store.claims[0]?.releasedAt, ENDED_AT);
    assert.equal(store.claims[0]?.releaseReason, 'MEMBERSHIP_ENDED');
    assert.equal(store.claims[0]?.updatedAt, ENDED_AT);
    assert.equal(store.claims[0]?.claimantMembershipId, MEMBERSHIP);
    assert.equal(store.entries[0]?.status, 'OPEN');
    assert.equal(store.entries[0]?.updatedAt, CLAIMED_AT);
  });

  void it('releases every active claim owned by the ending Membership', async () => {
    const store = storeOf({
      entries: [
        entry({ id: 'entry-a' }),
        entry({ id: 'entry-b' }),
        entry({ id: 'entry-c' }),
      ],
      claims: [
        claim({ id: 'claim-a', supplyEntryId: 'entry-a' }),
        claim({ id: 'claim-b', supplyEntryId: 'entry-b' }),
        claim({ id: 'claim-c', supplyEntryId: 'entry-c' }),
      ],
    });
    await endExactTenure(store);
    for (const row of store.claims) {
      assert.equal(row.releaseReason, 'MEMBERSHIP_ENDED');
      assert.equal(row.releasedAt, ENDED_AT);
      assert.equal(row.updatedAt, ENDED_AT);
    }
  });

  void it('leaves an already-released claim unchanged', async () => {
    for (const reason of [
      'CLAIMANT_RELEASED',
      'ENTRY_OBTAINED',
      'ENTRY_CANCELED',
      'MEMBERSHIP_ENDED',
    ] as const) {
      const store = storeOf({
        claims: [
          claim({
            id: `released-${reason}`,
            supplyEntryId: 'entry-released',
            releasedAt: PREVIOUSLY_RELEASED_AT,
            releaseReason: reason,
            updatedAt: PREVIOUSLY_RELEASED_AT,
          }),
        ],
      });
      const before = structuredClone(store.claims[0]);
      await endExactTenure(store);
      assert.deepEqual(store.claims[0], before);
    }
  });

  void it('releases only the active claim in a mixed history', async () => {
    const store = storeOf({
      claims: [
        claim({
          id: 'historical',
          supplyEntryId: 'entry-old',
          releasedAt: PREVIOUSLY_RELEASED_AT,
          releaseReason: 'CLAIMANT_RELEASED',
          updatedAt: PREVIOUSLY_RELEASED_AT,
        }),
        claim({ id: 'active', supplyEntryId: 'entry-new' }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.claims[0]?.releasedAt, PREVIOUSLY_RELEASED_AT);
    assert.equal(store.claims[0]?.releaseReason, 'CLAIMANT_RELEASED');
    assert.equal(store.claims[0]?.updatedAt, PREVIOUSLY_RELEASED_AT);
    assert.equal(store.claims[1]?.releasedAt, ENDED_AT);
    assert.equal(store.claims[1]?.releaseReason, 'MEMBERSHIP_ENDED');
    assert.equal(store.claims[1]?.updatedAt, ENDED_AT);
  });

  void it('uses the supplied shared operation timestamp', async () => {
    const store = storeOf({
      claims: [claim({ id: 'stamp', supplyEntryId: 'entry-stamp' })],
    });
    await endExactTenure(store);
    assert.equal(store.claims[0]?.releasedAt, ENDED_AT);
    assert.equal(store.claims[0]?.updatedAt, ENDED_AT);
    assert.equal(store.calls[0]?.releasedAt, ENDED_AT);
  });

  void it('does not mutate SupplyEntry rows', async () => {
    const store = storeOf({
      entries: [
        entry({ id: 'open-entry', title: 'Soap', status: 'OPEN' }),
        entry({
          id: 'obtained-entry',
          title: 'Trash bags',
          status: 'OBTAINED',
          updatedAt: PREVIOUSLY_RELEASED_AT,
        }),
      ],
      claims: [claim({ id: 'open-claim', supplyEntryId: 'open-entry' })],
    });
    const before = structuredClone(store.entries);
    await endExactTenure(store);
    assert.deepEqual(store.entries, before);
  });

  void it('preserves claimantMembershipId on the released claim', async () => {
    const store = storeOf({
      claims: [claim({ id: 'attribution', supplyEntryId: 'entry-attr' })],
    });
    await endExactTenure(store);
    assert.equal(store.claims[0]?.claimantMembershipId, MEMBERSHIP);
  });

  void it('maps VOLUNTARY_LEAVE to MEMBERSHIP_ENDED', async () => {
    const store = storeOf({
      claims: [claim({ id: 'leave', supplyEntryId: 'entry-leave' })],
    });
    await endExactTenure(store, 'VOLUNTARY_LEAVE');
    assert.equal(store.claims[0]?.releaseReason, 'MEMBERSHIP_ENDED');
  });

  void it('maps ADMIN_REMOVAL to MEMBERSHIP_ENDED', async () => {
    const store = storeOf({
      claims: [claim({ id: 'remove', supplyEntryId: 'entry-remove' })],
    });
    await endExactTenure(store, 'ADMIN_REMOVAL');
    assert.equal(store.claims[0]?.releaseReason, 'MEMBERSHIP_ENDED');
  });

  void it('maps HOME_ARCHIVED to MEMBERSHIP_ENDED and never ENTRY_CANCELED', async () => {
    const store = storeOf({
      claims: [claim({ id: 'archive', supplyEntryId: 'entry-archive' })],
    });
    await endExactTenure(store, 'HOME_ARCHIVED');
    assert.equal(store.claims[0]?.releaseReason, 'MEMBERSHIP_ENDED');
    assert.notEqual(store.claims[0]?.releaseReason, 'ENTRY_CANCELED');
    assert.equal(store.entries.length, 0);
  });

  void it('enforces exact Home scope even if the same membership id appears elsewhere', async () => {
    const store = storeOf({
      claims: [
        claim({
          id: 'other-home',
          homeId: OTHER_HOME,
          supplyEntryId: 'foreign-entry',
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.claims[0]?.releasedAt, null);
    assert.equal(store.claims[0]?.releaseReason, null);
    assert.equal(store.calls[0]?.homeId, HOME);
  });

  void it('enforces exact Membership tenure', async () => {
    const store = storeOf({
      claims: [
        claim({
          id: 'other-tenure',
          supplyEntryId: 'entry-other',
          claimantMembershipId: OTHER_MEMBERSHIP,
        }),
      ],
    });
    await endExactTenure(store);
    assert.equal(store.claims[0]?.releasedAt, null);
    assert.equal(store.claims[0]?.claimantMembershipId, OTHER_MEMBERSHIP);
    assert.notEqual(store.calls[0]?.membershipId, OTHER_MEMBERSHIP);
  });

  void it('does not rewrite a prior tenure claim when a later rejoined tenure ends', async () => {
    const store = storeOf({
      claims: [
        claim({
          id: 'old-history',
          supplyEntryId: 'entry-old',
          claimantMembershipId: MEMBERSHIP,
          releasedAt: PREVIOUSLY_RELEASED_AT,
          releaseReason: 'MEMBERSHIP_ENDED',
          updatedAt: PREVIOUSLY_RELEASED_AT,
        }),
        claim({
          id: 'rejoined-active',
          supplyEntryId: 'entry-rejoin',
          claimantMembershipId: REJOINED_MEMBERSHIP,
        }),
      ],
    });
    await store.cleanup.handleMembershipEnded(TX, {
      homeId: HOME,
      membershipId: REJOINED_MEMBERSHIP,
      endedAt: ENDED_AT,
      cause: 'VOLUNTARY_LEAVE',
    });
    assert.equal(store.claims[0]?.claimantMembershipId, MEMBERSHIP);
    assert.equal(store.claims[0]?.releasedAt, PREVIOUSLY_RELEASED_AT);
    assert.equal(store.claims[0]?.releaseReason, 'MEMBERSHIP_ENDED');
    assert.equal(store.claims[0]?.updatedAt, PREVIOUSLY_RELEASED_AT);
    assert.equal(store.claims[1]?.claimantMembershipId, REJOINED_MEMBERSHIP);
    assert.equal(store.claims[1]?.releasedAt, ENDED_AT);
    assert.equal(store.claims[1]?.releaseReason, 'MEMBERSHIP_ENDED');
  });

  void it('does not emit a Supply event', async () => {
    const source = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'membership-ending-supply-cleanup.ts',
      ),
      'utf8',
    );
    assert.doesNotMatch(source, /outbox/);
    assert.doesNotMatch(source, /supply\.claim_released/);
    assert.doesNotMatch(source, /supply\.updated/);
    assert.doesNotMatch(source, /supply\.membership_cleanup/);
    const store = storeOf({
      claims: [claim({ id: 'no-event', supplyEntryId: 'entry-no-event' })],
    });
    await endExactTenure(store);
    assert.equal(store.calls.length, 1);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { StructuralIntegrityError } from './structure-errors.js';
import {
  LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL,
  lockHomeAndExactMemberships,
  TRY_LOCK_HOME_FOR_UPDATE_SQL,
  tryLockHomeAndExactMemberships,
  uniqueSortedMembershipIds,
} from './lock-home-and-exact-memberships.js';
import { LOCK_HOME_FOR_UPDATE_SQL } from './lock-home-structure.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP_LOW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_HIGH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type RecordedQuery = {
  text: string;
  values: unknown[];
};

function txWith(script: {
  home?: { id: string; archived_at: Date | null; timezone?: string }[];
  memberships?: Record<
    string,
    {
      id: string;
      user_id: string;
      home_id: string;
      role: string;
      ended_at: Date | null;
    }
  >;
  failOn?: 'home' | 'membership';
}): { tx: TransactionContext; queries: RecordedQuery[] } {
  const home = script.home ?? [
    { id: HOME_A, archived_at: null, timezone: 'UTC' },
  ];
  const memberships = script.memberships ?? {};
  const queries: RecordedQuery[] = [];

  return {
    queries,
    tx: {
      query<T>(text: string, values?: readonly unknown[]) {
        queries.push({ text, values: [...(values ?? [])] });
        if (script.failOn === 'home' && text.includes('FROM homes')) {
          return Promise.reject(new Error('home lock failed'));
        }
        if (
          script.failOn === 'membership' &&
          text.includes('FROM memberships')
        ) {
          return Promise.reject(new Error('membership lock failed'));
        }
        if (text.includes('FROM homes')) {
          return Promise.resolve({
            rows: home as T[],
            rowCount: home.length,
          });
        }
        if (text.includes('FROM memberships')) {
          const id = typeof values?.[0] === 'string' ? values[0] : '';
          const row = memberships[id];
          const rows = row === undefined ? [] : [row];
          return Promise.resolve({
            rows: rows as T[],
            rowCount: rows.length,
          });
        }
        return Promise.reject(new Error(`unexpected query: ${text}`));
      },
    },
  };
}

void describe('lockHomeAndExactMemberships', () => {
  void it('uses FOR UPDATE, not FOR KEY SHARE, on Home and Membership', () => {
    assert.match(LOCK_HOME_FOR_UPDATE_SQL, /FOR UPDATE/);
    assert.doesNotMatch(LOCK_HOME_FOR_UPDATE_SQL, /FOR KEY SHARE/);
    assert.doesNotMatch(LOCK_HOME_FOR_UPDATE_SQL, /FOR NO KEY UPDATE/);
    assert.match(LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL, /FOR UPDATE/);
    assert.doesNotMatch(LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL, /FOR KEY SHARE/);
    assert.doesNotMatch(
      LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL,
      /FOR NO KEY UPDATE/,
    );
    assert.match(LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL, /WHERE id = \$1/);
    assert.match(TRY_LOCK_HOME_FOR_UPDATE_SQL, /FOR UPDATE SKIP LOCKED/);
  });

  void it('returns null without Membership locks when Home is unavailable', async () => {
    const { tx, queries } = txWith({ home: [] });
    const locked = await tryLockHomeAndExactMemberships(tx, {
      homeId: HOME_A,
      membershipIds: [MEMBERSHIP_LOW],
    });
    assert.equal(locked, null);
    assert.equal(queries[0]?.text, TRY_LOCK_HOME_FOR_UPDATE_SQL);
    assert.equal(
      queries.some((query) => query.text.includes('FROM memberships')),
      false,
    );
  });

  void it('uses the non-blocking Home lock before exact Membership locks', async () => {
    const { tx, queries } = txWith({
      memberships: {
        [MEMBERSHIP_LOW]: {
          id: MEMBERSHIP_LOW,
          user_id: USER_A,
          home_id: HOME_A,
          role: 'ROOMMATE',
          ended_at: null,
        },
      },
    });
    const locked = await tryLockHomeAndExactMemberships(tx, {
      homeId: HOME_A,
      membershipIds: [MEMBERSHIP_LOW],
    });
    assert.ok(locked);
    assert.equal(queries[0]?.text, TRY_LOCK_HOME_FOR_UPDATE_SQL);
    assert.equal(queries[1]?.text, LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL);
  });

  void it('sorts and deduplicates Membership ids before locking', () => {
    assert.deepEqual(
      uniqueSortedMembershipIds([
        MEMBERSHIP_HIGH,
        MEMBERSHIP_LOW,
        MEMBERSHIP_HIGH,
      ]),
      [MEMBERSHIP_LOW, MEMBERSHIP_HIGH],
    );
  });

  void it('locks Home first, then Memberships in ascending id order', async () => {
    const { tx, queries } = txWith({
      memberships: {
        [MEMBERSHIP_LOW]: {
          id: MEMBERSHIP_LOW,
          user_id: USER_A,
          home_id: HOME_A,
          role: 'ROOMMATE',
          ended_at: null,
        },
        [MEMBERSHIP_HIGH]: {
          id: MEMBERSHIP_HIGH,
          user_id: USER_B,
          home_id: HOME_A,
          role: 'ADMIN',
          ended_at: null,
        },
      },
    });

    const locked = await lockHomeAndExactMemberships(tx, {
      homeId: HOME_A,
      membershipIds: [MEMBERSHIP_HIGH, MEMBERSHIP_LOW],
    });

    assert.equal(queries[0]?.text, LOCK_HOME_FOR_UPDATE_SQL);
    assert.deepEqual(queries[0]?.values, [HOME_A]);
    assert.equal(queries[1]?.text, LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL);
    assert.deepEqual(queries[1]?.values, [MEMBERSHIP_LOW]);
    assert.equal(queries[2]?.text, LOCK_EXACT_MEMBERSHIP_FOR_UPDATE_SQL);
    assert.deepEqual(queries[2]?.values, [MEMBERSHIP_HIGH]);
    assert.deepEqual(
      locked.memberships.map((membership) => membership.id),
      [MEMBERSHIP_LOW, MEMBERSHIP_HIGH],
    );
    assert.equal(locked.home.archivedAt, null);
    assert.equal(locked.home.timezone, 'UTC');
  });

  void it('locks a Membership only once when actor and assignee are the same', async () => {
    const { tx, queries } = txWith({
      memberships: {
        [MEMBERSHIP_LOW]: {
          id: MEMBERSHIP_LOW,
          user_id: USER_A,
          home_id: HOME_A,
          role: 'ROOMMATE',
          ended_at: null,
        },
      },
    });

    const locked = await lockHomeAndExactMemberships(tx, {
      homeId: HOME_A,
      membershipIds: [MEMBERSHIP_LOW, MEMBERSHIP_LOW],
    });

    assert.equal(
      queries.filter((query) => query.text.includes('FROM memberships')).length,
      1,
    );
    assert.equal(locked.memberships.length, 1);
    assert.equal(locked.memberships[0]?.id, MEMBERSHIP_LOW);
  });

  void it('returns an ended Membership so the caller can revalidate', async () => {
    const endedAt = new Date('2026-09-12T18:00:00.000Z');
    const { tx } = txWith({
      memberships: {
        [MEMBERSHIP_LOW]: {
          id: MEMBERSHIP_LOW,
          user_id: USER_A,
          home_id: HOME_A,
          role: 'ROOMMATE',
          ended_at: endedAt,
        },
      },
    });

    const locked = await lockHomeAndExactMemberships(tx, {
      homeId: HOME_A,
      membershipIds: [MEMBERSHIP_LOW],
    });
    assert.deepEqual(locked.memberships[0]?.endedAt, endedAt);
  });

  void it('omits unknown Membership ids without leaking a different error', async () => {
    const { tx } = txWith({ memberships: {} });
    const locked = await lockHomeAndExactMemberships(tx, {
      homeId: HOME_A,
      membershipIds: [MEMBERSHIP_LOW],
    });
    assert.deepEqual(locked.memberships, []);
  });

  void it('conceals a missing Home', async () => {
    const { tx } = txWith({ home: [] });
    await assert.rejects(
      () =>
        lockHomeAndExactMemberships(tx, {
          homeId: HOME_A,
          membershipIds: [MEMBERSHIP_LOW],
        }),
      ConcealedNotFoundError,
    );
  });

  void it('conceals an archived Home before locking Memberships', async () => {
    const { tx, queries } = txWith({
      home: [{ id: HOME_A, archived_at: new Date(), timezone: 'UTC' }],
    });
    await assert.rejects(
      () =>
        lockHomeAndExactMemberships(tx, {
          homeId: HOME_A,
          membershipIds: [MEMBERSHIP_LOW],
        }),
      ConcealedNotFoundError,
    );
    assert.equal(
      queries.some((query) => query.text.includes('FROM memberships')),
      false,
    );
  });

  void it('fails closed when Home lock SQL fails', async () => {
    const { tx } = txWith({ failOn: 'home' });
    await assert.rejects(
      () =>
        lockHomeAndExactMemberships(tx, {
          homeId: HOME_A,
          membershipIds: [MEMBERSHIP_LOW],
        }),
      TransactionInfrastructureError,
    );
  });

  void it('fails closed when Membership lock SQL fails', async () => {
    const { tx } = txWith({ failOn: 'membership' });
    await assert.rejects(
      () =>
        lockHomeAndExactMemberships(tx, {
          homeId: HOME_A,
          membershipIds: [MEMBERSHIP_LOW],
        }),
      TransactionInfrastructureError,
    );
  });

  void it('fails closed on an impossible Home duplicate', async () => {
    const { tx } = txWith({
      home: [
        { id: HOME_A, archived_at: null },
        { id: HOME_A, archived_at: null },
      ],
    });
    await assert.rejects(
      () =>
        lockHomeAndExactMemberships(tx, {
          homeId: HOME_A,
          membershipIds: [],
        }),
      StructuralIntegrityError,
    );
  });
});

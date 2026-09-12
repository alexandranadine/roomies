import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  AuthorizationIntegrityError,
  ConcealedNotFoundError,
} from '../../platform/authz/errors.js';
import { StructuralIntegrityError } from './structure-errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { lockHomeStructure } from './lock-home-structure.js';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_OLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_NEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function actor(overrides: Partial<ActiveHomeActor> = {}): ActiveHomeActor {
  return {
    userId: USER_A,
    membershipId: MEMBERSHIP_NEW,
    homeId: HOME_A,
    role: 'ADMIN',
    ...overrides,
  };
}

function txWith(script: {
  home?: { id: string; archived_at: Date | null }[];
  memberships?: {
    id: string;
    user_id: string;
    home_id: string;
    role: string;
  }[];
}): TransactionContext {
  const home = script.home ?? [{ id: HOME_A, archived_at: null }];
  const memberships = script.memberships ?? [];
  return {
    query<T>(text: string) {
      if (text.includes('FROM homes')) {
        return Promise.resolve({ rows: home as T[], rowCount: home.length });
      }
      if (text.includes('FROM memberships')) {
        return Promise.resolve({
          rows: memberships as T[],
          rowCount: memberships.length,
        });
      }
      return Promise.reject(new Error(`unexpected query: ${text}`));
    },
  };
}

void describe('lockHomeStructure revalidation', () => {
  void it('returns the transaction-current role when middleware says ADMIN', async () => {
    const locked = await lockHomeStructure(
      txWith({
        memberships: [
          {
            id: MEMBERSHIP_NEW,
            user_id: USER_A,
            home_id: HOME_A,
            role: 'ROOMMATE',
          },
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            user_id: '22222222-2222-4222-8222-222222222222',
            home_id: HOME_A,
            role: 'ADMIN',
          },
        ],
      }),
      { homeId: HOME_A, actor: actor({ role: 'ADMIN' }) },
    );

    assert.equal(locked.actor.role, 'ROOMMATE');
    assert.equal(locked.actor.membershipId, MEMBERSHIP_NEW);
    assert.notEqual(locked.actor.role, actor({ role: 'ADMIN' }).role);
  });

  void it('returns the transaction-current role when middleware says ROOMMATE', async () => {
    const locked = await lockHomeStructure(
      txWith({
        memberships: [
          {
            id: MEMBERSHIP_NEW,
            user_id: USER_A,
            home_id: HOME_A,
            role: 'ADMIN',
          },
        ],
      }),
      { homeId: HOME_A, actor: actor({ role: 'ROOMMATE' }) },
    );

    assert.equal(locked.actor.role, 'ADMIN');
  });

  void it('does not map an ended tenure to a newer active Membership', async () => {
    await assert.rejects(
      () =>
        lockHomeStructure(
          txWith({
            memberships: [
              {
                id: MEMBERSHIP_NEW,
                user_id: USER_A,
                home_id: HOME_A,
                role: 'ADMIN',
              },
            ],
          }),
          {
            homeId: HOME_A,
            actor: actor({ membershipId: MEMBERSHIP_OLD, role: 'ADMIN' }),
          },
        ),
      ConcealedNotFoundError,
    );
  });

  void it('succeeds when the exact current tenure id is supplied', async () => {
    const locked = await lockHomeStructure(
      txWith({
        memberships: [
          {
            id: MEMBERSHIP_NEW,
            user_id: USER_A,
            home_id: HOME_A,
            role: 'ADMIN',
          },
        ],
      }),
      { homeId: HOME_A, actor: actor({ membershipId: MEMBERSHIP_NEW }) },
    );
    assert.equal(locked.actor.membershipId, MEMBERSHIP_NEW);
  });

  void it('conceals a cross-Home actor as NOT_FOUND', async () => {
    await assert.rejects(
      () =>
        lockHomeStructure(
          txWith({
            home: [{ id: HOME_B, archived_at: null }],
            memberships: [
              {
                id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                user_id: USER_A,
                home_id: HOME_B,
                role: 'ADMIN',
              },
            ],
          }),
          { homeId: HOME_B, actor: actor({ homeId: HOME_A, role: 'ADMIN' }) },
        ),
      ConcealedNotFoundError,
    );
  });

  void it('conceals an archived Home as NOT_FOUND', async () => {
    await assert.rejects(
      () =>
        lockHomeStructure(
          txWith({
            home: [{ id: HOME_A, archived_at: new Date() }],
            memberships: [
              {
                id: MEMBERSHIP_NEW,
                user_id: USER_A,
                home_id: HOME_A,
                role: 'ADMIN',
              },
            ],
          }),
          { homeId: HOME_A, actor: actor() },
        ),
      ConcealedNotFoundError,
    );
  });

  void it('conceals a missing Home as NOT_FOUND', async () => {
    await assert.rejects(
      () =>
        lockHomeStructure(txWith({ home: [], memberships: [] }), {
          homeId: HOME_A,
          actor: actor(),
        }),
      ConcealedNotFoundError,
    );
  });

  void it('conceals an empty active set as NOT_FOUND', async () => {
    await assert.rejects(
      () =>
        lockHomeStructure(txWith({ memberships: [] }), {
          homeId: HOME_A,
          actor: actor(),
        }),
      ConcealedNotFoundError,
    );
  });

  void it('fails closed on an active Home with zero ADMINs', async () => {
    await assert.rejects(
      () =>
        lockHomeStructure(
          txWith({
            memberships: [
              {
                id: MEMBERSHIP_NEW,
                user_id: USER_A,
                home_id: HOME_A,
                role: 'ROOMMATE',
              },
            ],
          }),
          { homeId: HOME_A, actor: actor({ role: 'ADMIN' }) },
        ),
      (error: unknown) => {
        assert.ok(error instanceof StructuralIntegrityError);
        assert.equal(error instanceof AuthorizationIntegrityError, false);
        return true;
      },
    );
  });
});

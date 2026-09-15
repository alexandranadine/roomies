import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  CanonicalUserPersistenceIntegrityError,
  LOCK_CANONICAL_USER_FOR_UPDATE_SQL,
  MARK_CANONICAL_USER_DELETED_SQL,
  createCanonicalUserDeletionMarkerPersistence,
} from './canonical-user-deletion-marker.js';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DELETED_AT = new Date('2026-09-14T20:00:00.000Z');

void describe('canonical User deletion marker persistence', () => {
  void it('locks the canonical User by UUID and returns deletedAt', async () => {
    const calls: unknown[] = [];
    const tx: TransactionContext = {
      query: (text, values) => {
        calls.push({ text, values });
        return Promise.resolve({
          rows: [{ id: USER_ID, deleted_at: null }] as never,
          rowCount: 1,
        });
      },
    };

    const locked =
      await createCanonicalUserDeletionMarkerPersistence().lockByUserId(
        tx,
        USER_ID,
      );

    assert.deepEqual(locked, { userId: USER_ID, deletedAt: null });
    assert.deepEqual(calls, [
      { text: LOCK_CANONICAL_USER_FOR_UPDATE_SQL, values: [USER_ID] },
    ]);
    assert.match(LOCK_CANONICAL_USER_FOR_UPDATE_SQL, /FROM users/i);
    assert.match(LOCK_CANONICAL_USER_FOR_UPDATE_SQL, /deleted_at/);
    assert.match(LOCK_CANONICAL_USER_FOR_UPDATE_SQL, /WHERE id = \$1/);
    assert.match(LOCK_CANONICAL_USER_FOR_UPDATE_SQL, /FOR UPDATE/);
    assert.doesNotMatch(LOCK_CANONICAL_USER_FOR_UPDATE_SQL, /DELETE FROM/i);
    assert.doesNotMatch(LOCK_CANONICAL_USER_FOR_UPDATE_SQL, /memberships/i);
    assert.doesNotMatch(LOCK_CANONICAL_USER_FOR_UPDATE_SQL, /auth_/i);
  });

  void it('returns null when the canonical User row is missing', async () => {
    const tx: TransactionContext = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    };

    assert.equal(
      await createCanonicalUserDeletionMarkerPersistence().lockByUserId(
        tx,
        USER_ID,
      ),
      null,
    );
  });

  void it('sets deleted_at only for a live canonical User', async () => {
    const calls: unknown[] = [];
    const tx: TransactionContext = {
      query: (text, values) => {
        calls.push({ text, values });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    };

    assert.equal(
      await createCanonicalUserDeletionMarkerPersistence().markDeleted(tx, {
        userId: USER_ID,
        deletedAt: DELETED_AT,
      }),
      1,
    );
    assert.deepEqual(calls, [
      {
        text: MARK_CANONICAL_USER_DELETED_SQL,
        values: [DELETED_AT, USER_ID],
      },
    ]);
    assert.match(MARK_CANONICAL_USER_DELETED_SQL, /SET deleted_at = \$1/);
    assert.match(MARK_CANONICAL_USER_DELETED_SQL, /id = \$2/);
    assert.match(MARK_CANONICAL_USER_DELETED_SQL, /deleted_at IS NULL/);
    assert.doesNotMatch(MARK_CANONICAL_USER_DELETED_SQL, /updated_at/);
    assert.doesNotMatch(MARK_CANONICAL_USER_DELETED_SQL, /DELETE FROM/i);
    assert.doesNotMatch(MARK_CANONICAL_USER_DELETED_SQL, /memberships/i);
    assert.doesNotMatch(MARK_CANONICAL_USER_DELETED_SQL, /auth_/i);
  });

  void it('fails closed on malformed lock rows without leaking identifiers', async () => {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => JSON.stringify(value)).join(' '));
    };
    const tx: TransactionContext = {
      query: () =>
        Promise.resolve({
          rows: [{ id: USER_ID, deleted_at: 'not-a-timestamp' }] as never,
          rowCount: 1,
        }),
    };

    try {
      await assert.rejects(
        () =>
          createCanonicalUserDeletionMarkerPersistence().lockByUserId(
            tx,
            USER_ID,
          ),
        CanonicalUserPersistenceIntegrityError,
      );
      assert.equal(logs.join('\n').includes(USER_ID), false);
      assert.equal(logs.join('\n').includes('deletedAt'), false);
      assert.equal(logs.join('\n').includes('deleted_at'), false);
    } finally {
      console.error = originalError;
    }
  });

  void it('normalizes query failures to infrastructure error', async () => {
    const tx: TransactionContext = {
      query: () => Promise.reject(new Error('secret database detail')),
    };
    const persistence = createCanonicalUserDeletionMarkerPersistence();

    await assert.rejects(
      () => persistence.lockByUserId(tx, USER_ID),
      TransactionInfrastructureError,
    );
    await assert.rejects(
      () =>
        persistence.markDeleted(tx, {
          userId: USER_ID,
          deletedAt: DELETED_AT,
        }),
      TransactionInfrastructureError,
    );
  });
});

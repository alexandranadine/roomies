import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionInfrastructureError } from '../../platform/persistence/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL,
  createMembershipRoleTransitionWriter,
} from './insert-membership-role-transition.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TRANSITION = '018f1e2c-7e3a-7000-8000-1234567890ab';
const CHANGED_AT = new Date('2026-03-15T12:34:56.789Z');

type QueryCall = { sql: string; values: unknown[] };

function fakeTx(
  calls: QueryCall[],
  options: { rowCount?: number | null; error?: Error } = {},
): TransactionContext {
  return {
    query(sql, values) {
      calls.push({ sql, values: values === undefined ? [] : [...values] });
      if (options.error) {
        return Promise.reject(options.error);
      }
      return Promise.resolve({
        rows: [],
        rowCount: options.rowCount ?? 1,
      });
    },
  };
}

void describe('insert membership role transition', () => {
  void it('inserts the immutable required fields without role snapshots or userId', () => {
    assert.match(
      INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL,
      /INSERT INTO membership_role_transitions/,
    );
    assert.match(INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL, /actor_membership_id/);
    assert.match(INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL, /changed_at/);
    assert.match(INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL, /created_at/);
    assert.doesNotMatch(INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL, /user_id/);
    assert.doesNotMatch(
      INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL,
      /old_role|new_role|previous_role/,
    );
    assert.doesNotMatch(
      INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL,
      /display|prose|title/i,
    );
  });

  void it('passes the application-generated id and frozen timestamps', async () => {
    const calls: QueryCall[] = [];
    const writer = createMembershipRoleTransitionWriter();
    const inserted = await writer.insertTransition(fakeTx(calls), {
      id: TRANSITION,
      homeId: HOME,
      membershipId: SUBJECT,
      actorMembershipId: ACTOR,
      changedAt: CHANGED_AT,
      createdAt: CHANGED_AT,
    });

    assert.equal(inserted, 1);
    assert.equal(calls[0]?.sql, INSERT_MEMBERSHIP_ROLE_TRANSITION_SQL);
    assert.deepEqual(calls[0]?.values, [
      TRANSITION,
      HOME,
      SUBJECT,
      ACTOR,
      CHANGED_AT,
      CHANGED_AT,
    ]);
  });

  void it('does not expose database errors', async () => {
    const writer = createMembershipRoleTransitionWriter();
    await assert.rejects(
      () =>
        writer.insertTransition(
          fakeTx([], {
            error: new Error('INSERT membership_role_transitions failed'),
          }),
          {
            id: TRANSITION,
            homeId: HOME,
            membershipId: SUBJECT,
            actorMembershipId: ACTOR,
            changedAt: CHANGED_AT,
            createdAt: CHANGED_AT,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof TransactionInfrastructureError);
        assert.equal(error.message.includes('INSERT'), false);
        assert.equal(
          error.message.includes('membership_role_transitions'),
          false,
        );
        return true;
      },
    );
  });
});

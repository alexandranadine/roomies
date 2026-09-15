import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { InvitationPersistenceError } from './errors.js';
import { createEraseInvitationsForTargetEmail } from './erase-invitations-for-target-email.js';
import type { TargetEmailInvitationRef } from './repository.js';

const TX = {} as TransactionContext;
const TARGET = normalizeEmail('target@example.com');
const INVITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOME_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HOME_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function ref(id: string, homeId: string): TargetEmailInvitationRef {
  return Object.freeze({ id, homeId });
}

void describe('createEraseInvitationsForTargetEmail', () => {
  void it('is a no-op when no invitations match the target email', async () => {
    const calls: string[] = [];
    const erase = createEraseInvitationsForTargetEmail({
      lockByInvitedEmailForErase(_tx, input) {
        calls.push(`lock:${input.invitedEmail}`);
        return Promise.resolve(Object.freeze([]));
      },
      deleteLockedForTargetEmailErase() {
        calls.push('delete');
        return Promise.resolve(0);
      },
    });

    await erase(TX, { invitedEmail: TARGET });
    assert.deepEqual(calls, [`lock:${TARGET}`]);
  });

  void it('rejects non-canonical email before locking', async () => {
    const calls: string[] = [];
    const erase = createEraseInvitationsForTargetEmail({
      lockByInvitedEmailForErase() {
        calls.push('lock');
        return Promise.resolve(Object.freeze([]));
      },
      deleteLockedForTargetEmailErase() {
        calls.push('delete');
        return Promise.resolve(0);
      },
    });

    await assert.rejects(
      () =>
        erase(TX, {
          invitedEmail: 'Not-Canonical@Example.COM' as typeof TARGET,
        }),
      InvitationPersistenceError,
    );
    assert.deepEqual(calls, []);
  });

  void it('locks then deletes every matched invitation id', async () => {
    const calls: string[] = [];
    const erase = createEraseInvitationsForTargetEmail({
      lockByInvitedEmailForErase(_tx, input) {
        calls.push(`lock:${input.invitedEmail}`);
        assert.equal(_tx, TX);
        return Promise.resolve(
          Object.freeze([ref(INVITE_A, HOME_A), ref(INVITE_B, HOME_B)]),
        );
      },
      deleteLockedForTargetEmailErase(_tx, input) {
        calls.push(`delete:${[...input.invitationIds].join(',')}`);
        assert.equal(_tx, TX);
        return Promise.resolve(2);
      },
    });

    await erase(TX, { invitedEmail: TARGET });
    assert.deepEqual(calls, [
      `lock:${TARGET}`,
      `delete:${INVITE_A},${INVITE_B}`,
    ]);
  });

  void it('fails when delete row count does not match locked ids', async () => {
    const erase = createEraseInvitationsForTargetEmail({
      lockByInvitedEmailForErase() {
        return Promise.resolve(Object.freeze([ref(INVITE_A, HOME_A)]));
      },
      deleteLockedForTargetEmailErase() {
        return Promise.resolve(0);
      },
    });

    await assert.rejects(
      () => erase(TX, { invitedEmail: TARGET }),
      InvitationPersistenceError,
    );
  });
});

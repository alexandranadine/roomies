import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FinalMemberRequiredError } from '../../domains/homes/errors.js';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { ForbiddenError } from '../../platform/authz/errors.js';
import type {
  JsonObject,
  OutboxEventInput,
} from '../../platform/events/outbox-types.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { createArchiveFinalMemberHome } from './archive-final-member-home.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const OTHER_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EVENT_ONE = '018f1e2c-7e3a-7000-8000-1234567890ab';
const EVENT_TWO = '018f1e2c-7e3a-7001-8000-1234567890ab';
const NOW = new Date('2026-09-12T20:00:00.000Z');

function locked(
  role: 'ADMIN' | 'ROOMMATE' = 'ADMIN',
  includeOther = false,
): LockedHomeStructure {
  const actorMembership = { id: MEMBERSHIP, userId: USER, homeId: HOME, role };
  return {
    home: { id: HOME },
    actor: { userId: USER, membershipId: MEMBERSHIP, homeId: HOME, role },
    activeMemberships: [
      actorMembership,
      ...(includeOther
        ? [
            {
              id: OTHER_MEMBERSHIP,
              userId: OTHER_USER,
              homeId: HOME,
              role: 'ADMIN' as const,
            },
          ]
        : []),
    ],
  };
}

function harness(
  options: {
    locked?: LockedHomeStructure;
    homeRows?: number;
    failAt?: string;
  } = {},
) {
  const tx = { query: () => Promise.reject(new Error('unexpected SQL')) };
  const steps: string[] = [];
  const events: OutboxEventInput<string, JsonObject>[] = [];
  const ids = [EVENT_ONE, EVENT_TWO];
  let clockCalls = 0;
  let transactionCalls = 0;

  const command = createArchiveFinalMemberHome({
    clock: {
      now() {
        clockCalls += 1;
        return NOW;
      },
    },
    runTransaction: async (work) => {
      transactionCalls += 1;
      return work(tx as TransactionContext);
    },
    lockHomeStructure: (_tx, input) => {
      steps.push('lock-home-structure');
      assert.equal(_tx, tx);
      assert.equal(input.actor.role, 'ROOMMATE');
      return Promise.resolve(options.locked ?? locked());
    },
    invitationRevoker: {
      lockPendingForHomeArchive(receivedTx, input) {
        steps.push('invitation-lock');
        assert.equal(receivedTx, tx);
        assert.deepEqual(input, {
          homeId: HOME,
          archivedAt: NOW,
          cause: 'HOME_ARCHIVED',
        });
        if (options.failAt === 'invitation-lock') {
          return Promise.reject(new Error('invitation lock failure'));
        }
        return Promise.resolve();
      },
      revokeLockedPendingForHomeArchive(receivedTx, input) {
        steps.push('invitation-revoke');
        assert.equal(receivedTx, tx);
        assert.equal(input.archivedAt, NOW);
        if (options.failAt === 'invitation-revoke') {
          return Promise.reject(new Error('invitation revoke failure'));
        }
        return Promise.resolve();
      },
    },
    applyMembershipEnding: (receivedTx, input) => {
      steps.push('membership-ending');
      assert.equal(receivedTx, tx);
      assert.deepEqual(input, {
        homeId: HOME,
        membershipId: MEMBERSHIP,
        endedAt: NOW,
        cause: 'HOME_ARCHIVED',
      });
      if (options.failAt === 'membership') {
        return Promise.reject(new Error('membership failure'));
      }
      return Promise.resolve({ membershipId: MEMBERSHIP });
    },
    homeArchive: {
      archiveActiveHome(receivedTx, input) {
        steps.push('home-archive');
        assert.equal(receivedTx, tx);
        assert.deepEqual(input, { homeId: HOME, archivedAt: NOW });
        return Promise.resolve(options.homeRows ?? 1);
      },
    },
    outbox: {
      append(receivedTx, event) {
        steps.push(`outbox-${event.eventType}`);
        assert.equal(receivedTx, tx);
        if (
          options.failAt === 'first-outbox' &&
          event.eventType === 'membership.ended.v1'
        ) {
          return Promise.reject(new Error('first outbox failure'));
        }
        if (
          options.failAt === 'second-outbox' &&
          event.eventType === 'home.archived.v1'
        ) {
          return Promise.reject(new Error('second outbox failure'));
        }
        events.push(event);
        return Promise.resolve();
      },
    },
    ids: { next: () => ids.shift() ?? 'unexpected-id' },
  });

  return {
    command,
    steps,
    events,
    stats: () => ({ clockCalls, transactionCalls }),
  };
}

const input = {
  homeId: HOME,
  actor: {
    userId: USER,
    membershipId: MEMBERSHIP,
    homeId: HOME,
    role: 'ROOMMATE' as const,
  },
};

void describe('archive final member Home orchestration', () => {
  void it('uses locked role and performs the frozen effect/append order', async () => {
    const { command, steps, events, stats } = harness();
    await command(input);

    assert.deepEqual(steps, [
      'lock-home-structure',
      'invitation-lock',
      'invitation-revoke',
      'membership-ending',
      'home-archive',
      'outbox-membership.ended.v1',
      'outbox-home.archived.v1',
    ]);
    assert.deepEqual(stats(), { clockCalls: 1, transactionCalls: 1 });
    assert.deepEqual(
      events.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        homeId: event.homeId,
        payload: event.payload,
      })),
      [
        {
          eventId: EVENT_ONE,
          eventType: 'membership.ended.v1',
          occurredAt: NOW,
          homeId: HOME,
          payload: { membershipId: MEMBERSHIP, cause: 'HOME_ARCHIVED' },
        },
        {
          eventId: EVENT_TWO,
          eventType: 'home.archived.v1',
          occurredAt: NOW,
          homeId: HOME,
          payload: { homeId: HOME },
        },
      ],
    );
  });

  void it('returns FINAL_MEMBER_REQUIRED for a locked Admin with another member', async () => {
    const { command, steps } = harness({ locked: locked('ADMIN', true) });
    await assert.rejects(() => command(input), FinalMemberRequiredError);
    assert.deepEqual(steps, ['lock-home-structure']);
  });

  void it('returns FORBIDDEN for a locked Roommate in valid multi-member state', async () => {
    const { command, steps } = harness({ locked: locked('ROOMMATE', true) });
    await assert.rejects(() => command(input), ForbiddenError);
    assert.deepEqual(steps, ['lock-home-structure']);
  });

  void it('treats a lone Roommate and sole-member mismatch as integrity failures', async () => {
    await assert.rejects(
      () => harness({ locked: locked('ROOMMATE') }).command(input),
      StructuralIntegrityError,
    );
    const mismatch = locked();
    await assert.rejects(
      () =>
        harness({
          locked: {
            ...mismatch,
            activeMemberships: [
              {
                ...mismatch.activeMemberships[0]!,
                id: OTHER_MEMBERSHIP,
              },
            ],
          },
        }).command(input),
      StructuralIntegrityError,
    );
  });

  void it('stops after each injected stage failure or unexpected Home row count', async () => {
    for (const failAt of [
      'invitation-lock',
      'invitation-revoke',
      'membership',
      'first-outbox',
      'second-outbox',
    ]) {
      await assert.rejects(() => harness({ failAt }).command(input));
    }
    await assert.rejects(
      () => harness({ homeRows: 0 }).command(input),
      StructuralIntegrityError,
    );
  });
});

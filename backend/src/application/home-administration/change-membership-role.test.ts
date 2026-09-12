import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { LastAdminRequiredError } from '../../domains/memberships/errors.js';
import type { ChangeMembershipRoleInput } from '../../domains/memberships/change-role.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import type {
  JsonObject,
  OutboxEventInput,
} from '../../platform/events/outbox-types.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { createChangeMembershipRole } from './change-membership-role.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBERSHIP_OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_HOME_MEMBERSHIP = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OCCURRED_AT = new Date('2026-03-15T12:34:56.789Z');

function actor(overrides: Partial<ActiveHomeActor> = {}): ActiveHomeActor {
  return {
    userId: USER_A,
    membershipId: MEMBERSHIP_A,
    homeId: HOME,
    role: 'ADMIN',
    ...overrides,
  };
}

function structure(
  memberships: LockedHomeStructure['activeMemberships'],
  actorOverride?: LockedHomeStructure['actor'],
): LockedHomeStructure {
  const lockedActor = actorOverride ?? {
    userId: memberships[0]?.userId ?? USER_A,
    membershipId: memberships[0]?.id ?? MEMBERSHIP_A,
    homeId: HOME,
    role: memberships[0]?.role ?? 'ADMIN',
  };
  return {
    home: { id: HOME },
    actor: lockedActor,
    activeMemberships: memberships,
  };
}

function twoAdminHome(): LockedHomeStructure {
  return structure([
    { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ADMIN' },
    { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
  ]);
}

function adminRoommateHome(): LockedHomeStructure {
  return structure([
    { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ADMIN' },
    { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ROOMMATE' },
  ]);
}

function commandOf(options: {
  locked: LockedHomeStructure;
  updateRows?: number;
  outboxError?: Error;
}) {
  const updates: unknown[] = [];
  const events: OutboxEventInput<string, JsonObject>[] = [];
  const change = createChangeMembershipRole({
    runTransaction: async (work) => work({} as TransactionContext),
    lockHomeStructure: () => Promise.resolve(options.locked),
    outbox: {
      append(_tx, event) {
        if (options.outboxError) {
          return Promise.reject(options.outboxError);
        }
        events.push(event);
        return Promise.resolve();
      },
    },
    clock: { now: () => OCCURRED_AT },
    ids: { next: () => EVENT_ID },
    roleWriter: {
      updateActiveRole(_tx, input) {
        updates.push(input);
        return Promise.resolve(options.updateRows ?? 1);
      },
    },
  });
  return { change, updates, events };
}

function input(
  overrides: Partial<ChangeMembershipRoleInput> = {},
): ChangeMembershipRoleInput {
  return {
    actor: actor(),
    homeId: HOME,
    membershipId: MEMBERSHIP_B,
    role: 'ADMIN',
    ...overrides,
  };
}

void describe('changeMembershipRole application orchestration', () => {
  void it('authorizes from the locked role when the HTTP snapshot is stale ADMIN', async () => {
    const { change, updates, events } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({ role: 'ROOMMATE' }),
      ),
    });

    await assert.rejects(
      () =>
        change(
          input({
            actor: actor({ role: 'ADMIN' }),
            membershipId: MEMBERSHIP_B,
            role: 'ROOMMATE',
          }),
        ),
      ForbiddenError,
    );
    assert.deepEqual(updates, []);
    assert.deepEqual(events, []);
  });

  void it('treats a current zero-Admin snapshot as structural integrity, not LAST_ADMIN', async () => {
    const { change, updates, events } = commandOf({
      locked: structure([
        { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
        { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ROOMMATE' },
      ]),
    });

    await assert.rejects(() => change(input()), StructuralIntegrityError);
    assert.deepEqual(updates, []);
    assert.deepEqual(events, []);
  });

  void it('conceals a target that is not in the locked active set', async () => {
    const { change, updates } = commandOf({ locked: adminRoommateHome() });

    await assert.rejects(
      () => change(input({ membershipId: MEMBERSHIP_OLD })),
      ConcealedNotFoundError,
    );
    await assert.rejects(
      () => change(input({ membershipId: OTHER_HOME_MEMBERSHIP })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(updates, []);
  });

  void it('returns a successful no-op after authorization when the role already matches', async () => {
    const { change, updates, events } = commandOf({
      locked: adminRoommateHome(),
    });

    const result = await change(
      input({ membershipId: MEMBERSHIP_B, role: 'ROOMMATE' }),
    );

    assert.deepEqual(result, { changed: false });
    assert.deepEqual(updates, []);
    assert.deepEqual(events, []);
  });

  void it('rejects last-Admin demotion without mutating', async () => {
    const { change, updates, events } = commandOf({
      locked: adminRoommateHome(),
    });

    await assert.rejects(
      () => change(input({ membershipId: MEMBERSHIP_A, role: 'ROOMMATE' })),
      LastAdminRequiredError,
    );
    assert.deepEqual(updates, []);
    assert.deepEqual(events, []);
  });

  void it('updates and appends one role_changed event on an actual transition', async () => {
    const { change, updates, events } = commandOf({
      locked: adminRoommateHome(),
    });

    const result = await change(
      input({ membershipId: MEMBERSHIP_B, role: 'ADMIN' }),
    );

    assert.deepEqual(result, {
      changed: true,
      previousRole: 'ROOMMATE',
      newRole: 'ADMIN',
    });
    assert.deepEqual(updates, [
      {
        membershipId: MEMBERSHIP_B,
        homeId: HOME,
        previousRole: 'ROOMMATE',
        newRole: 'ADMIN',
      },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'membership.role_changed.v1');
    assert.equal(events[0]?.eventId, EVENT_ID);
    assert.equal(events[0]?.occurredAt, OCCURRED_AT);
    assert.equal(events[0]?.homeId, HOME);
    assert.deepEqual(events[0]?.payload, {
      membershipId: MEMBERSHIP_B,
      previousRole: 'ROOMMATE',
      newRole: 'ADMIN',
    });
  });

  void it('treats a post-lock zero-row UPDATE as structural integrity', async () => {
    const { change, events } = commandOf({
      locked: adminRoommateHome(),
      updateRows: 0,
    });

    await assert.rejects(() => change(input()), StructuralIntegrityError);
    assert.deepEqual(events, []);
  });

  void it('allows self-demotion while another Admin remains', async () => {
    const { change, updates } = commandOf({ locked: twoAdminHome() });

    const result = await change(
      input({ membershipId: MEMBERSHIP_A, role: 'ROOMMATE' }),
    );

    assert.equal(result.changed, true);
    assert.deepEqual(updates, [
      {
        membershipId: MEMBERSHIP_A,
        homeId: HOME,
        previousRole: 'ADMIN',
        newRole: 'ROOMMATE',
      },
    ]);
  });
});

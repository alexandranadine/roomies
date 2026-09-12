import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import {
  LastAdminRequiredError,
  LastRoommateRequiresArchiveError,
} from '../../domains/memberships/errors.js';
import type { LeaveMembershipInput } from '../../domains/memberships/leave.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type { EndMembershipWithinHomeStructureInput } from './end-membership-within-home-structure.js';
import { createLeaveMembership } from './leave-membership.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBERSHIP_OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_HOME_MEMBERSHIP = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ENDED_AT = new Date('2026-03-15T12:34:56.789Z');

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

function commandOf(options: { locked: LockedHomeStructure; endError?: Error }) {
  const endings: EndMembershipWithinHomeStructureInput[] = [];
  const leave = createLeaveMembership({
    runTransaction: async (work) => work({} as TransactionContext),
    lockHomeStructure: () => Promise.resolve(options.locked),
    clock: { now: () => ENDED_AT },
    endMembership(_tx, input) {
      if (options.endError) {
        return Promise.reject(options.endError);
      }
      endings.push(input);
      return Promise.resolve({ membershipId: input.membershipId });
    },
  });
  return { leave, endings };
}

function input(
  overrides: Partial<LeaveMembershipInput> = {},
): LeaveMembershipInput {
  return {
    actor: actor(),
    homeId: HOME,
    membershipId: MEMBERSHIP_A,
    ...overrides,
  };
}

void describe('leaveMembership application orchestration', () => {
  void it('allows a Roommate leave when an Admin remains', async () => {
    const { leave, endings } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ADMIN' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ROOMMATE' },
        ],
        actor({
          userId: USER_B,
          membershipId: MEMBERSHIP_B,
          role: 'ROOMMATE',
        }),
      ),
    });

    await leave(
      input({
        actor: actor({
          userId: USER_B,
          membershipId: MEMBERSHIP_B,
          role: 'ROOMMATE',
        }),
        membershipId: MEMBERSHIP_B,
      }),
    );

    assert.deepEqual(endings, [
      {
        homeId: HOME,
        membershipId: MEMBERSHIP_B,
        endedAt: ENDED_AT,
        cause: 'VOLUNTARY_LEAVE',
      },
    ]);
  });

  void it('allows an Admin leave when another Admin remains', async () => {
    const { leave, endings } = commandOf({ locked: twoAdminHome() });

    await leave(input({ membershipId: MEMBERSHIP_A }));

    assert.deepEqual(endings, [
      {
        homeId: HOME,
        membershipId: MEMBERSHIP_A,
        endedAt: ENDED_AT,
        cause: 'VOLUNTARY_LEAVE',
      },
    ]);
  });

  void it('rejects last-Admin leave without invoking the ending seam', async () => {
    const { leave, endings } = commandOf({ locked: adminRoommateHome() });

    await assert.rejects(
      () => leave(input({ membershipId: MEMBERSHIP_A })),
      LastAdminRequiredError,
    );
    assert.deepEqual(endings, []);
  });

  void it('rejects sole-Admin leave with LAST_ROOMMATE_REQUIRES_ARCHIVE', async () => {
    const { leave, endings } = commandOf({
      locked: structure([
        { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ADMIN' },
      ]),
    });

    await assert.rejects(
      () => leave(input({ membershipId: MEMBERSHIP_A })),
      LastRoommateRequiresArchiveError,
    );
    assert.deepEqual(endings, []);
  });

  void it('treats a current zero-Admin snapshot as structural integrity before policy', async () => {
    const { leave, endings } = commandOf({
      locked: structure([
        { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
      ]),
    });

    await assert.rejects(
      () => leave(input({ membershipId: MEMBERSHIP_A })),
      StructuralIntegrityError,
    );
    assert.deepEqual(endings, []);
  });

  void it('evaluates leave from the locked role when the HTTP snapshot is stale ADMIN', async () => {
    const { leave, endings } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({ role: 'ROOMMATE' }),
      ),
    });

    await leave(
      input({
        actor: actor({ role: 'ADMIN' }),
        membershipId: MEMBERSHIP_A,
      }),
    );

    assert.deepEqual(endings, [
      {
        homeId: HOME,
        membershipId: MEMBERSHIP_A,
        endedAt: ENDED_AT,
        cause: 'VOLUNTARY_LEAVE',
      },
    ]);
  });

  void it('forbids leave against another visible same-Home Membership', async () => {
    const { leave, endings } = commandOf({ locked: adminRoommateHome() });

    await assert.rejects(
      () => leave(input({ membershipId: MEMBERSHIP_B })),
      ForbiddenError,
    );
    assert.deepEqual(endings, []);
  });

  void it('conceals a path target absent from the locked active set', async () => {
    const { leave, endings } = commandOf({ locked: adminRoommateHome() });

    await assert.rejects(
      () => leave(input({ membershipId: MEMBERSHIP_OLD })),
      ConcealedNotFoundError,
    );
    await assert.rejects(
      () => leave(input({ membershipId: OTHER_HOME_MEMBERSHIP })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(endings, []);
  });

  void it('ends the locked actor Membership, not a remapped Home id', async () => {
    const { leave, endings } = commandOf({ locked: twoAdminHome() });

    await leave(
      input({
        homeId: OTHER_HOME,
        membershipId: MEMBERSHIP_A,
      }),
    );

    assert.equal(endings[0]?.homeId, HOME);
    assert.equal(endings[0]?.membershipId, MEMBERSHIP_A);
    assert.equal(endings[0]?.cause, 'VOLUNTARY_LEAVE');
  });
});

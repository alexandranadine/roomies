import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import {
  LastAdminRequiredError,
  LastRoommateRequiresArchiveError,
} from '../../domains/memberships/errors.js';
import type { RemoveMembershipInput } from '../../domains/memberships/remove.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import type { EndMembershipWithinHomeStructureInput } from './end-membership-within-home-structure.js';
import { createRemoveMembership } from './remove-membership.js';

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
  const remove = createRemoveMembership({
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
  return { remove, endings };
}

function input(
  overrides: Partial<RemoveMembershipInput> = {},
): RemoveMembershipInput {
  return {
    actor: actor(),
    homeId: HOME,
    membershipId: MEMBERSHIP_B,
    ...overrides,
  };
}

void describe('removeMembership application orchestration', () => {
  void it('allows an Admin to remove a Roommate through the ending seam', async () => {
    const { remove, endings } = commandOf({ locked: adminRoommateHome() });

    await remove(input({ membershipId: MEMBERSHIP_B }));

    assert.deepEqual(endings, [
      {
        homeId: HOME,
        membershipId: MEMBERSHIP_B,
        endedAt: ENDED_AT,
        cause: 'ADMIN_REMOVAL',
      },
    ]);
  });

  void it('allows an Admin to remove another Admin when an Admin remains', async () => {
    const { remove, endings } = commandOf({ locked: twoAdminHome() });

    await remove(input({ membershipId: MEMBERSHIP_B }));

    assert.deepEqual(endings, [
      {
        homeId: HOME,
        membershipId: MEMBERSHIP_B,
        endedAt: ENDED_AT,
        cause: 'ADMIN_REMOVAL',
      },
    ]);
  });

  void it('forbids a Roommate before target lookup so existence is not leaked', async () => {
    const { remove, endings } = commandOf({
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
        remove(
          input({
            actor: actor({ role: 'ROOMMATE' }),
            membershipId: MEMBERSHIP_B,
          }),
        ),
      ForbiddenError,
    );
    await assert.rejects(
      () =>
        remove(
          input({
            actor: actor({ role: 'ROOMMATE' }),
            membershipId: MEMBERSHIP_OLD,
          }),
        ),
      ForbiddenError,
    );
    assert.deepEqual(endings, []);
  });

  void it('forbids self-remove without treating it as leave or archive', async () => {
    const { remove, endings } = commandOf({ locked: adminRoommateHome() });

    await assert.rejects(
      () => remove(input({ membershipId: MEMBERSHIP_A })),
      ForbiddenError,
    );
    await assert.rejects(
      () => remove(input({ membershipId: MEMBERSHIP_A })),
      (error: unknown) =>
        error instanceof ForbiddenError &&
        !(error instanceof LastRoommateRequiresArchiveError) &&
        !(error instanceof LastAdminRequiredError),
    );
    assert.deepEqual(endings, []);
  });

  void it('forbids sole-Admin self-remove without LAST_ROOMMATE_REQUIRES_ARCHIVE', async () => {
    const { remove, endings } = commandOf({
      locked: structure([
        { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ADMIN' },
      ]),
    });

    await assert.rejects(
      () => remove(input({ membershipId: MEMBERSHIP_A })),
      ForbiddenError,
    );
    await assert.rejects(
      () => remove(input({ membershipId: MEMBERSHIP_A })),
      (error: unknown) => !(error instanceof LastRoommateRequiresArchiveError),
    );
    assert.deepEqual(endings, []);
  });

  void it('rejects a proposed zero-Admin remaining set without invoking the seam', async () => {
    const { remove, endings } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({
          userId: USER_A,
          membershipId: MEMBERSHIP_A,
          role: 'ADMIN',
        }),
      ),
    });

    await assert.rejects(
      () => remove(input({ membershipId: MEMBERSHIP_B })),
      LastAdminRequiredError,
    );
    assert.deepEqual(endings, []);
  });

  void it('treats a current zero-Admin snapshot as structural integrity before policy', async () => {
    const { remove, endings } = commandOf({
      locked: structure([
        { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
        { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ROOMMATE' },
      ]),
    });

    await assert.rejects(() => remove(input()), StructuralIntegrityError);
    assert.deepEqual(endings, []);
  });

  void it('authorizes from the locked role when the HTTP snapshot is stale ADMIN', async () => {
    const { remove, endings } = commandOf({
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
        remove(
          input({
            actor: actor({ role: 'ADMIN' }),
            membershipId: MEMBERSHIP_B,
          }),
        ),
      ForbiddenError,
    );
    assert.deepEqual(endings, []);
  });

  void it('conceals a target that is not in the locked active set', async () => {
    const { remove, endings } = commandOf({ locked: adminRoommateHome() });

    await assert.rejects(
      () => remove(input({ membershipId: MEMBERSHIP_OLD })),
      ConcealedNotFoundError,
    );
    await assert.rejects(
      () => remove(input({ membershipId: OTHER_HOME_MEMBERSHIP })),
      ConcealedNotFoundError,
    );
    assert.deepEqual(endings, []);
  });

  void it('ends the locked Home target, not a remapped request Home id', async () => {
    const { remove, endings } = commandOf({ locked: adminRoommateHome() });

    await remove(
      input({
        homeId: OTHER_HOME,
        membershipId: MEMBERSHIP_B,
      }),
    );

    assert.equal(endings[0]?.homeId, HOME);
    assert.equal(endings[0]?.membershipId, MEMBERSHIP_B);
    assert.equal(endings[0]?.cause, 'ADMIN_REMOVAL');
  });

  void it('does not invoke the ending seam when authorization fails', async () => {
    const { remove, endings } = commandOf({
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
        remove(
          input({
            actor: actor({ role: 'ROOMMATE' }),
            membershipId: MEMBERSHIP_B,
          }),
        ),
      ForbiddenError,
    );
    assert.deepEqual(endings, []);
  });
});

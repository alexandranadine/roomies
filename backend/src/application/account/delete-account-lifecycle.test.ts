import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LockedHomeEntryStructure } from '../../domains/homes/locked-home-structure.js';
import { LastAdminRequiredError } from '../../domains/memberships/errors.js';
import type { UserMembershipTenure } from '../../domains/memberships/list-user-membership-tenures.js';
import type { LockedCanonicalUser } from '../../domains/users/canonical-user-deletion-marker.js';
import type { CurrentCanonicalIdentity } from '../../platform/auth/canonical-identity-by-user.js';
import { AuthInfrastructureError } from '../../platform/auth/errors.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createDeleteAccountLifecycle,
  type DeleteAccountLifecycleDependencies,
} from './delete-account-lifecycle.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ENDED = '99999999-9999-4999-8999-999999999999';
const OCCURRED_AT = new Date('2026-09-15T18:00:00.000Z');
const DELETED_AT = new Date('2026-09-14T21:00:00.000Z');
const EMAIL = normalizeEmail('lifecycle@example.com');

const tx = { query: () => Promise.reject(new Error('unexpected SQL')) };

function identity(): CurrentCanonicalIdentity {
  return Object.freeze({
    userId: USER,
    email: EMAIL,
    emailVerified: true,
  });
}

function tenure(
  membershipId: string,
  homeId: string,
  endedAt: Date | null = null,
): UserMembershipTenure {
  return Object.freeze({ membershipId, homeId, endedAt });
}

function lockedHome(input: {
  homeId: string;
  archived?: boolean;
  memberships: LockedHomeEntryStructure['activeMemberships'];
}): LockedHomeEntryStructure {
  return Object.freeze({
    home: Object.freeze({
      id: input.homeId,
      archived: input.archived === true,
    }),
    activeMemberships: Object.freeze(input.memberships),
  });
}

function harness(
  options: {
    lockedUser?: LockedCanonicalUser | null;
    identity?: CurrentCanonicalIdentity | null;
    tenures?: readonly UserMembershipTenure[];
    homes?: Readonly<Record<string, LockedHomeEntryStructure>>;
    markRows?: number;
    failAt?: string;
  } = {},
) {
  const steps: string[] = [];
  const archives: { homeId: string; membershipId: string; archivedAt: Date }[] =
    [];
  const endings: {
    homeId: string;
    membershipId: string;
    endedAt: Date;
    cause: string;
  }[] = [];
  const maintenance: (readonly string[])[] = [];
  const invitations: string[] = [];
  const marks: Date[] = [];
  const teardowns: { userId: string; email: string }[] = [];
  let clockCalls = 0;
  let transactionCalls = 0;

  const homes = options.homes ?? {
    [HOME_A]: lockedHome({
      homeId: HOME_A,
      memberships: [
        { id: MEMBERSHIP_A, userId: USER, homeId: HOME_A, role: 'ROOMMATE' },
        { id: OTHER_A, userId: OTHER_USER, homeId: HOME_A, role: 'ADMIN' },
      ],
    }),
  };

  const deps: DeleteAccountLifecycleDependencies = {
    runTransaction: async (work) => {
      transactionCalls += 1;
      return work(tx as TransactionContext);
    },
    lockCanonicalUser: (_tx, userId) => {
      steps.push('lock-user');
      assert.equal(_tx, tx);
      assert.equal(userId, USER);
      return Promise.resolve(
        options.lockedUser === undefined
          ? { userId: USER, deletedAt: null }
          : options.lockedUser,
      );
    },
    findCanonicalIdentity: (_tx, userId) => {
      steps.push('capture-identity');
      assert.equal(userId, USER);
      return Promise.resolve(
        options.identity === undefined ? identity() : options.identity,
      );
    },
    listTenures: () => {
      steps.push('discover-tenures');
      return Promise.resolve(
        options.tenures ?? [
          tenure(MEMBERSHIP_A, HOME_A),
          tenure(ENDED, HOME_A, DELETED_AT),
        ],
      );
    },
    lockHomeEntry: (_tx, input) => {
      steps.push(`lock-home:${input.homeId}`);
      const locked = homes[input.homeId];
      if (locked === undefined) {
        throw new Error(`unexpected home lock ${input.homeId}`);
      }
      return Promise.resolve(locked);
    },
    clock: {
      now() {
        clockCalls += 1;
        steps.push('clock-now');
        return OCCURRED_AT;
      },
    },
    applyArchive: (_tx, input) => {
      steps.push(`archive:${input.homeId}`);
      archives.push(input);
      if (options.failAt === 'archive') {
        return Promise.reject(new Error('injected archive failure'));
      }
      return Promise.resolve();
    },
    endMembership: (_tx, input) => {
      steps.push(`leave:${input.homeId}`);
      endings.push({
        homeId: input.homeId,
        membershipId: input.membershipId,
        endedAt: input.endedAt,
        cause: input.cause,
      });
      if (options.failAt === 'leave') {
        return Promise.reject(new Error('injected leave failure'));
      }
      return Promise.resolve({ membershipId: input.membershipId });
    },
    eraseMaintenance: (_tx, input) => {
      steps.push('erase-maintenance');
      maintenance.push(input.membershipIds);
      if (options.failAt === 'maintenance') {
        return Promise.reject(new Error('injected maintenance failure'));
      }
      return Promise.resolve();
    },
    eraseInvitations: (_tx, input) => {
      steps.push('erase-invitations');
      invitations.push(input.invitedEmail);
      if (options.failAt === 'invitations') {
        return Promise.reject(new Error('injected invitation failure'));
      }
      return Promise.resolve();
    },
    markDeleted: (_tx, input) => {
      steps.push('mark-deleted');
      marks.push(input.deletedAt);
      if (options.failAt === 'mark') {
        return Promise.reject(new Error('injected mark failure'));
      }
      return Promise.resolve(options.markRows ?? 1);
    },
    teardownAuth: {
      teardownAuthForIdentity(_tx, captured) {
        steps.push('auth-teardown');
        teardowns.push({ userId: captured.userId, email: captured.email });
        if (options.failAt === 'teardown') {
          return Promise.reject(new Error('injected teardown failure'));
        }
        return Promise.resolve();
      },
    },
    hooks: {
      afterGlobalPreflight: () => {
        steps.push('preflight');
        if (options.failAt === 'preflight') {
          return Promise.reject(new Error('injected preflight failure'));
        }
        return Promise.resolve();
      },
      beforeCommit: () => {
        steps.push('before-commit');
        if (options.failAt === 'commit') {
          return Promise.reject(new Error('injected commit failure'));
        }
        return Promise.resolve();
      },
    },
  };

  return {
    command: createDeleteAccountLifecycle(deps),
    steps,
    archives,
    endings,
    maintenance,
    invitations,
    marks,
    teardowns,
    stats: () => ({ clockCalls, transactionCalls }),
  };
}

void describe('delete account lifecycle orchestration', () => {
  void it('locks User, Homes, then Memberships before the first mutation', async () => {
    const { command, steps, stats, endings, maintenance, marks, teardowns } =
      harness({
        homes: {
          [HOME_B]: lockedHome({
            homeId: HOME_B,
            memberships: [
              {
                id: MEMBERSHIP_B,
                userId: USER,
                homeId: HOME_B,
                role: 'ROOMMATE',
              },
              {
                id: OTHER_B,
                userId: OTHER_USER,
                homeId: HOME_B,
                role: 'ADMIN',
              },
            ],
          }),
          [HOME_A]: lockedHome({
            homeId: HOME_A,
            memberships: [
              {
                id: MEMBERSHIP_A,
                userId: USER,
                homeId: HOME_A,
                role: 'ROOMMATE',
              },
              {
                id: OTHER_A,
                userId: OTHER_USER,
                homeId: HOME_A,
                role: 'ADMIN',
              },
            ],
          }),
        },
        tenures: [tenure(MEMBERSHIP_B, HOME_B), tenure(MEMBERSHIP_A, HOME_A)],
      });

    const result = await command({ userId: USER });
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(steps, [
      'lock-user',
      'capture-identity',
      'discover-tenures',
      `lock-home:${HOME_A}`,
      `lock-home:${HOME_B}`,
      'preflight',
      'clock-now',
      `leave:${HOME_A}`,
      `leave:${HOME_B}`,
      'erase-maintenance',
      'erase-invitations',
      'mark-deleted',
      'auth-teardown',
      'before-commit',
    ]);
    assert.deepEqual(stats(), { clockCalls: 1, transactionCalls: 1 });
    assert.equal(endings.length, 2);
    assert.equal(endings[0]?.endedAt, OCCURRED_AT);
    assert.equal(endings[0]?.cause, 'VOLUNTARY_LEAVE');
    assert.deepEqual(maintenance[0], [MEMBERSHIP_B, MEMBERSHIP_A]);
    assert.deepEqual(marks, [OCCURRED_AT]);
    assert.deepEqual(teardowns, [{ userId: USER, email: EMAIL }]);
  });

  void it('archives the final active roommate after global preflight', async () => {
    const { command, steps, archives, endings } = harness({
      tenures: [tenure(MEMBERSHIP_A, HOME_A)],
      homes: {
        [HOME_A]: lockedHome({
          homeId: HOME_A,
          memberships: [
            { id: MEMBERSHIP_A, userId: USER, homeId: HOME_A, role: 'ADMIN' },
          ],
        }),
      },
    });
    await command({ userId: USER });
    assert.deepEqual(archives, [
      { homeId: HOME_A, membershipId: MEMBERSHIP_A, archivedAt: OCCURRED_AT },
    ]);
    assert.deepEqual(endings, []);
    assert.ok(steps.indexOf(`archive:${HOME_A}`) > steps.indexOf('preflight'));
  });

  void it('blocks LAST_ADMIN_REQUIRED before any mutation', async () => {
    const { command, steps, endings, archives, maintenance, marks, teardowns } =
      harness({
        tenures: [tenure(MEMBERSHIP_A, HOME_A), tenure(MEMBERSHIP_B, HOME_B)],
        homes: {
          [HOME_A]: lockedHome({
            homeId: HOME_A,
            memberships: [
              {
                id: MEMBERSHIP_A,
                userId: USER,
                homeId: HOME_A,
                role: 'ROOMMATE',
              },
              {
                id: OTHER_A,
                userId: OTHER_USER,
                homeId: HOME_A,
                role: 'ADMIN',
              },
            ],
          }),
          [HOME_B]: lockedHome({
            homeId: HOME_B,
            memberships: [
              { id: MEMBERSHIP_B, userId: USER, homeId: HOME_B, role: 'ADMIN' },
              {
                id: OTHER_B,
                userId: OTHER_USER,
                homeId: HOME_B,
                role: 'ROOMMATE',
              },
            ],
          }),
        },
      });

    await assert.rejects(
      () => command({ userId: USER }),
      LastAdminRequiredError,
    );
    assert.deepEqual(steps, [
      'lock-user',
      'capture-identity',
      'discover-tenures',
      `lock-home:${HOME_A}`,
      `lock-home:${HOME_B}`,
    ]);
    assert.deepEqual(endings, []);
    assert.deepEqual(archives, []);
    assert.deepEqual(maintenance, []);
    assert.deepEqual(marks, []);
    assert.deepEqual(teardowns, []);
  });

  void it('returns already_deleted without identity, mutation, or auth teardown', async () => {
    const { command, steps, stats, endings, maintenance, marks, teardowns } =
      harness({
        lockedUser: { userId: USER, deletedAt: DELETED_AT },
      });
    const result = await command({ userId: USER });
    assert.equal(result.outcome, 'already_deleted');
    assert.deepEqual(steps, ['lock-user']);
    assert.deepEqual(stats(), { clockCalls: 0, transactionCalls: 1 });
    assert.deepEqual(endings, []);
    assert.deepEqual(maintenance, []);
    assert.deepEqual(marks, []);
    assert.deepEqual(teardowns, []);
  });

  void it('treats a missing User as structural integrity', async () => {
    const { command, steps } = harness({ lockedUser: null });
    await assert.rejects(
      () => command({ userId: USER }),
      StructuralIntegrityError,
    );
    assert.deepEqual(steps, ['lock-user']);
  });

  void it('requires captured identity to belong to the locked User', async () => {
    const { command } = harness({
      identity: {
        userId: OTHER_USER,
        email: EMAIL,
        emailVerified: true,
      },
    });
    await assert.rejects(
      () => command({ userId: USER }),
      AuthInfrastructureError,
    );
  });

  void it('skips structural mutation for historical-only Homes and still erases sources', async () => {
    const { command, steps, endings, archives, maintenance } = harness({
      tenures: [tenure(ENDED, HOME_A, DELETED_AT)],
      homes: {
        [HOME_A]: lockedHome({
          homeId: HOME_A,
          archived: true,
          memberships: [],
        }),
      },
    });
    const result = await command({ userId: USER });
    assert.equal(result.outcome, 'completed');
    assert.ok(!steps.includes(`leave:${HOME_A}`));
    assert.ok(!steps.includes(`archive:${HOME_A}`));
    assert.deepEqual(endings, []);
    assert.deepEqual(archives, []);
    assert.deepEqual(maintenance[0], [ENDED]);
    assert.ok(steps.includes('erase-invitations'));
    assert.ok(steps.includes('auth-teardown'));
  });

  void it('uses one lifecycle timestamp and tears auth down last', async () => {
    const { command, steps, endings, marks } = harness();
    await command({ userId: USER });
    assert.equal(endings[0]?.endedAt, OCCURRED_AT);
    assert.equal(marks[0], OCCURRED_AT);
    assert.ok(steps.indexOf('auth-teardown') > steps.indexOf('mark-deleted'));
    assert.ok(steps.indexOf('clock-now') > steps.indexOf('preflight'));
  });
});

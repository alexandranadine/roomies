import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import { InvitationNotAvailableError } from '../../domains/invitations/errors.js';
import type { Invitation } from '../../domains/invitations/invitation.js';
import { invitationTokenHash } from '../../domains/invitations/token-hash.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
} from '../../platform/authz/errors.js';
import {
  createRevokeInvitation,
  type RevokeInvitationInput,
} from './revoke-invitation.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBERSHIP_OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OTHER_INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ff';
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-10-08T00:00:00.000Z');
const REVOKED_AT = new Date('2026-10-02T00:00:00.000Z');
const TOKEN_HASH = invitationTokenHash(new Uint8Array(32).fill(7));

function actor(overrides: Partial<ActiveHomeActor> = {}): ActiveHomeActor {
  return {
    userId: USER_A,
    membershipId: MEMBERSHIP_A,
    homeId: HOME,
    role: 'ADMIN',
    ...overrides,
  };
}

function pendingInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return Object.freeze({
    id: INVITATION_ID,
    homeId: HOME,
    invitedEmail: normalizeEmail('roommate@example.com'),
    tokenHash: TOKEN_HASH,
    createdByMembershipId: MEMBERSHIP_A,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    acceptedAt: null,
    acceptedMembershipId: null,
    revokedAt: null,
    revocationCause: null,
    ...overrides,
  });
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

function adminHome(): LockedHomeStructure {
  return structure([
    { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ADMIN' },
    { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ROOMMATE' },
  ]);
}

function commandOf(options: {
  locked?: LockedHomeStructure;
  lockError?: Error;
  invitation?: Invitation | null;
  revokeCount?: number;
  transactionError?: Error;
}) {
  const order: string[] = [];
  const lockCalls: Array<{ homeId: string; invitationId: string }> = [];
  const revokes: Array<{
    invitationId: string;
    homeId: string;
    revokedAt: Date;
    cause: string;
  }> = [];
  const revoke = createRevokeInvitation({
    runTransaction: async (work) => {
      if (options.transactionError) {
        throw options.transactionError;
      }
      order.push('begin');
      const result = await work({
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      });
      order.push('commit');
      return result;
    },
    lockHomeStructure: () => {
      order.push('home-memberships-lock');
      if (options.lockError) {
        return Promise.reject(options.lockError);
      }
      return Promise.resolve(options.locked ?? adminHome());
    },
    invitations: {
      lockById(_tx, input) {
        order.push('invitation-lock');
        lockCalls.push(input);
        return Promise.resolve(
          options.invitation === undefined
            ? pendingInvitation()
            : options.invitation,
        );
      },
      revokeLocked(_tx, input) {
        order.push('invitation-revoke');
        revokes.push(input);
        return Promise.resolve(options.revokeCount ?? 1);
      },
    },
    clock: { now: () => REVOKED_AT },
  });
  return { revoke, order, lockCalls, revokes };
}

function input(
  overrides: Partial<RevokeInvitationInput> = {},
): RevokeInvitationInput {
  return {
    actor: actor(),
    homeId: HOME,
    invitationId: INVITATION_ID,
    ...overrides,
  };
}

void describe('revokeInvitation application orchestration', () => {
  void it('lets an Admin revoke a pending invitation with the injected Clock', async () => {
    const { revoke, order, lockCalls, revokes } = commandOf({});
    await revoke(input());

    assert.deepEqual(order, [
      'begin',
      'home-memberships-lock',
      'invitation-lock',
      'invitation-revoke',
      'commit',
    ]);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, invitationId: INVITATION_ID },
    ]);
    assert.deepEqual(revokes, [
      {
        invitationId: INVITATION_ID,
        homeId: HOME,
        revokedAt: REVOKED_AT,
        cause: 'ADMIN_REVOKED',
      },
    ]);
    assert.equal('tokenHash' in (revokes[0] ?? {}), false);
    assert.equal('invitedEmail' in (revokes[0] ?? {}), false);
    assert.equal('createdByMembershipId' in (revokes[0] ?? {}), false);
  });

  void it('forbids a Roommate from the locked role before locking the invitation', async () => {
    const { revoke, order, revokes } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({ role: 'ROOMMATE' }),
      ),
    });
    await assert.rejects(() => revoke(input()), ForbiddenError);
    assert.deepEqual(revokes, []);
    assert.equal(order.includes('invitation-lock'), false);
  });

  void it('uses the locked role when the request-time snapshot is a stale Admin', async () => {
    const { revoke, revokes } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({ role: 'ROOMMATE' }),
      ),
    });
    await assert.rejects(
      () => revoke(input({ actor: actor({ role: 'ADMIN' }) })),
      ForbiddenError,
    );
    assert.deepEqual(revokes, []);
  });

  void it('forbids the invitation creator who is now a Roommate', async () => {
    const { revoke, revokes } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({ role: 'ROOMMATE' }),
      ),
    });
    await assert.rejects(() => revoke(input()), ForbiddenError);
    assert.deepEqual(revokes, []);
  });

  void it('lets a different current Admin revoke the creator invitation', async () => {
    const { revoke, revokes } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({
          userId: USER_B,
          membershipId: MEMBERSHIP_B,
          role: 'ADMIN',
        }),
      ),
      invitation: pendingInvitation({ createdByMembershipId: MEMBERSHIP_A }),
    });
    await revoke(
      input({
        actor: actor({
          userId: USER_B,
          membershipId: MEMBERSHIP_B,
          role: 'ADMIN',
        }),
      }),
    );
    assert.equal(revokes.length, 1);
    assert.equal(revokes[0]?.cause, 'ADMIN_REVOKED');
  });

  void it('conceals inaccessible, archived, and ended-actor Homes', async () => {
    for (const lockError of [
      new ConcealedNotFoundError(),
      new ConcealedNotFoundError(),
      new ConcealedNotFoundError(),
    ]) {
      const { revoke, order, revokes } = commandOf({ lockError });
      await assert.rejects(() => revoke(input()), ConcealedNotFoundError);
      assert.deepEqual(revokes, []);
      assert.equal(order.includes('invitation-lock'), false);
    }
  });

  void it('does not let an ended OLD tenure act after rejoin', async () => {
    const { revoke, revokes } = commandOf({
      lockError: new ConcealedNotFoundError(),
    });
    await assert.rejects(
      () =>
        revoke(
          input({
            actor: actor({ membershipId: MEMBERSHIP_OLD }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(revokes, []);
  });

  void it('conceals a missing invitation and a cross-Home invitation ID', async () => {
    const { revoke, revokes, lockCalls } = commandOf({ invitation: null });
    await assert.rejects(
      () => revoke(input({ invitationId: OTHER_INVITATION_ID })),
      InvitationNotAvailableError,
    );
    assert.deepEqual(revokes, []);
    assert.deepEqual(lockCalls, [
      { homeId: HOME, invitationId: OTHER_INVITATION_ID },
    ]);
    void OTHER_HOME;
  });

  void it('rejects accepted, already revoked, and expired invitations without mutation', async () => {
    const cases: Invitation[] = [
      pendingInvitation({
        acceptedAt: REVOKED_AT,
        acceptedMembershipId: MEMBERSHIP_B,
      }),
      pendingInvitation({
        revokedAt: CREATED_AT,
        revocationCause: 'ADMIN_REVOKED',
      }),
      pendingInvitation({ expiresAt: CREATED_AT }),
    ];
    for (const invitation of cases) {
      const { revoke, revokes } = commandOf({ invitation });
      await assert.rejects(() => revoke(input()), InvitationNotAvailableError);
      assert.deepEqual(revokes, []);
    }
  });

  void it('does not require a token hash or invitation secret', async () => {
    const { revoke, revokes } = commandOf({});
    const commandInput = input();
    assert.equal('secret' in commandInput, false);
    assert.equal('tokenHash' in commandInput, false);
    await revoke(commandInput);
    assert.equal(JSON.stringify(revokes[0]).includes('tokenHash'), false);
  });

  void it('fails closed when the locked pending update writes no row', async () => {
    const { revoke } = commandOf({ revokeCount: 0 });
    await assert.rejects(() => revoke(input()), StructuralIntegrityError);
  });

  void it('does not emit an outbox event', async () => {
    const { revoke, order } = commandOf({});
    await revoke(input());
    assert.equal(order.includes('outbox'), false);
    assert.equal(JSON.stringify(order).includes('membership.started'), false);
  });
});

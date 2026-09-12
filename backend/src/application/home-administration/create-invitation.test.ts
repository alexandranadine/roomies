import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LockedHomeStructure } from '../../domains/homes/locked-home-structure.js';
import { StructuralIntegrityError } from '../../domains/homes/structure-errors.js';
import {
  AlreadyHomeMemberError,
  InvitationAlreadyPendingError,
  InvitationValidityConflictError,
} from '../../domains/invitations/errors.js';
import { INVITATION_LIFETIME_MS } from '../../domains/invitations/invitation.js';
import type { NewInvitation } from '../../domains/invitations/repository.js';
import {
  hashInvitationSecretBytes,
  type GeneratedInvitationSecret,
} from '../../domains/invitations/secret.js';
import { invitationTokenHash } from '../../domains/invitations/token-hash.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  ForbiddenError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import {
  createCreateInvitation,
  type CreateInvitationInput,
} from './create-invitation.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBERSHIP_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBERSHIP_OLD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');
const SECRET_BYTES = new Uint8Array(32).fill(9);
const SECRET: GeneratedInvitationSecret = Object.freeze({
  bytes: SECRET_BYTES,
  encoded: Buffer.from(SECRET_BYTES).toString(
    'base64url',
  ) as GeneratedInvitationSecret['encoded'],
});

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

function adminHome(): LockedHomeStructure {
  return structure([
    { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ADMIN' },
    { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ROOMMATE' },
  ]);
}

function commandOf(options: {
  locked?: LockedHomeStructure;
  lockError?: Error;
  pending?: { id: string } | null;
  identity?: {
    userId: string;
    email: ReturnType<typeof normalizeEmail>;
  } | null;
  identityError?: Error;
  insertError?: Error;
  transactionError?: Error;
}) {
  const inserts: NewInvitation[] = [];
  const savepoints: string[] = [];
  const create = createCreateInvitation({
    runTransaction: async (work) => {
      if (options.transactionError) {
        throw options.transactionError;
      }
      return work({
        query: (text) => {
          savepoints.push(text);
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      });
    },
    lockHomeStructure: () => {
      if (options.lockError) {
        return Promise.reject(options.lockError);
      }
      return Promise.resolve(options.locked ?? adminHome());
    },
    invitations: {
      insert(_tx, invitation) {
        if (options.insertError) {
          return Promise.reject(options.insertError);
        }
        inserts.push(invitation);
        return Promise.resolve();
      },
      findEffectivePending: () =>
        Promise.resolve(
          options.pending
            ? ({
                id: options.pending.id,
                homeId: HOME,
                invitedEmail: normalizeEmail('roommate@example.com'),
                tokenHash: invitationTokenHash(new Uint8Array(32).fill(1)),
                createdByMembershipId: MEMBERSHIP_A,
                createdAt: CREATED_AT,
                expiresAt: new Date('2026-10-08T00:00:00.000Z'),
                acceptedAt: null,
                acceptedMembershipId: null,
                revokedAt: null,
                revocationCause: null,
              } as never)
            : null,
        ),
    },
    findCanonicalIdentityByEmail: () => {
      if (options.identityError) {
        return Promise.reject(options.identityError);
      }
      return Promise.resolve(options.identity ?? null);
    },
    clock: { now: () => CREATED_AT },
    ids: { next: () => INVITATION_ID },
    invitationLifetimeMs: INVITATION_LIFETIME_MS,
    secrets: { generate: () => SECRET },
  });
  return { create, inserts, savepoints };
}

function input(
  overrides: Partial<CreateInvitationInput> = {},
): CreateInvitationInput {
  return {
    actor: actor(),
    homeId: HOME,
    email: '  Roommate@Example.com ',
    ...overrides,
  };
}

void describe('createInvitation application orchestration', () => {
  void it('lets an Admin create a normalized invitation with exact tenure', async () => {
    const { create, inserts } = commandOf({});
    const result = await create(input());

    assert.equal(result.invitation.id, INVITATION_ID);
    assert.equal(result.invitation.email, 'roommate@example.com');
    assert.deepEqual(
      result.invitation.expiresAt,
      new Date(CREATED_AT.getTime() + INVITATION_LIFETIME_MS),
    );
    assert.equal(result.rawSecret, SECRET.encoded);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0]?.invitedEmail, 'roommate@example.com');
    assert.equal(inserts[0]?.createdByMembershipId, MEMBERSHIP_A);
    assert.equal(inserts[0]?.homeId, HOME);
    assert.deepEqual(inserts[0]?.createdAt, CREATED_AT);
    assert.deepEqual(
      inserts[0]?.expiresAt,
      new Date(CREATED_AT.getTime() + INVITATION_LIFETIME_MS),
    );
    assert.deepEqual(
      [...(inserts[0]?.tokenHash ?? [])],
      [...hashInvitationSecretBytes(SECRET_BYTES)],
    );
    assert.equal('rawSecret' in (inserts[0] ?? {}), false);
    assert.equal(JSON.stringify(inserts[0]).includes(SECRET.encoded), false);
  });

  void it('forbids a Roommate from the locked role', async () => {
    const { create, inserts } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({ role: 'ROOMMATE' }),
      ),
    });
    await assert.rejects(() => create(input()), ForbiddenError);
    assert.deepEqual(inserts, []);
  });

  void it('uses the locked role when the request-time snapshot is a stale Admin', async () => {
    const { create, inserts } = commandOf({
      locked: structure(
        [
          { id: MEMBERSHIP_A, userId: USER_A, homeId: HOME, role: 'ROOMMATE' },
          { id: MEMBERSHIP_B, userId: USER_B, homeId: HOME, role: 'ADMIN' },
        ],
        actor({ role: 'ROOMMATE' }),
      ),
    });
    await assert.rejects(
      () => create(input({ actor: actor({ role: 'ADMIN' }) })),
      ForbiddenError,
    );
    assert.deepEqual(inserts, []);
  });

  void it('conceals inaccessible, archived, and ended-actor Homes', async () => {
    for (const lockError of [
      new ConcealedNotFoundError(),
      new ConcealedNotFoundError(),
      new ConcealedNotFoundError(),
    ]) {
      const { create, inserts } = commandOf({ lockError });
      await assert.rejects(() => create(input()), ConcealedNotFoundError);
      assert.deepEqual(inserts, []);
    }
  });

  void it('rejects an existing effective pending invitation', async () => {
    const { create, inserts } = commandOf({
      pending: { id: '018f1e2c-7e3a-7000-8000-1234567890ff' },
    });
    await assert.rejects(() => create(input()), InvitationAlreadyPendingError);
    assert.deepEqual(inserts, []);
  });

  void it('allows creation after expired, accepted, or revoked priors', async () => {
    const { create, inserts } = commandOf({ pending: null });
    const result = await create(input());
    assert.equal(result.invitation.id, INVITATION_ID);
    assert.equal(inserts.length, 1);
  });

  void it('rejects an active recipient in the locked Home', async () => {
    const { create, inserts } = commandOf({
      identity: {
        userId: USER_B,
        email: normalizeEmail('roommate@example.com'),
      },
    });
    await assert.rejects(() => create(input()), AlreadyHomeMemberError);
    assert.deepEqual(inserts, []);
  });

  void it('allows nonexistent and unverified recipient accounts', async () => {
    const missing = commandOf({ identity: null });
    const unverified = commandOf({
      identity: {
        userId: '33333333-3333-4333-8333-333333333333',
        email: normalizeEmail('roommate@example.com'),
      },
    });
    await missing.create(input());
    await unverified.create(input());
    assert.equal(missing.inserts.length, 1);
    assert.equal(unverified.inserts.length, 1);
  });

  void it('fails closed when canonical identity lookup is ambiguous', async () => {
    const { create, inserts } = commandOf({
      identityError: new Error('ambiguous identity'),
    });
    await assert.rejects(() => create(input()), StructuralIntegrityError);
    assert.deepEqual(inserts, []);
  });

  void it('rejects invalid email before generating persistence input', async () => {
    const { create, inserts } = commandOf({});
    await assert.rejects(
      () => create(input({ email: 'not-an-email' })),
      InvalidRequestError,
    );
    assert.deepEqual(inserts, []);
  });

  void it('maps a reconciled exclusion conflict to already pending', async () => {
    let pendingCalls = 0;
    const inserts: NewInvitation[] = [];
    const create = createCreateInvitation({
      runTransaction: async (work) =>
        work({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
        }),
      lockHomeStructure: () => Promise.resolve(adminHome()),
      invitations: {
        insert() {
          return Promise.reject(new InvitationValidityConflictError());
        },
        findEffectivePending() {
          pendingCalls += 1;
          if (pendingCalls === 1) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            id: '018f1e2c-7e3a-7000-8000-1234567890ee',
          } as never);
        },
      },
      findCanonicalIdentityByEmail: () => Promise.resolve(null),
      clock: { now: () => CREATED_AT },
      ids: { next: () => INVITATION_ID },
      invitationLifetimeMs: INVITATION_LIFETIME_MS,
      secrets: { generate: () => SECRET },
    });

    await assert.rejects(() => create(input()), InvitationAlreadyPendingError);
    assert.deepEqual(inserts, []);
  });

  void it('fails closed when 23P01 cannot be reconciled', async () => {
    const create = createCreateInvitation({
      runTransaction: async (work) =>
        work({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
        }),
      lockHomeStructure: () => Promise.resolve(adminHome()),
      invitations: {
        insert() {
          return Promise.reject(new InvitationValidityConflictError());
        },
        findEffectivePending: () => Promise.resolve(null),
      },
      findCanonicalIdentityByEmail: () => Promise.resolve(null),
      clock: { now: () => CREATED_AT },
      ids: { next: () => INVITATION_ID },
      invitationLifetimeMs: INVITATION_LIFETIME_MS,
      secrets: { generate: () => SECRET },
    });

    await assert.rejects(() => create(input()), StructuralIntegrityError);
  });

  void it('does not return a secret when the transaction fails', async () => {
    const { create } = commandOf({
      insertError: new Error('injected insert failure'),
    });
    await assert.rejects(() => create(input()), /injected insert failure/);
  });

  void it('does not let an ended OLD tenure act after rejoin', async () => {
    const { create, inserts } = commandOf({
      lockError: new ConcealedNotFoundError(),
    });
    await assert.rejects(
      () =>
        create(
          input({
            actor: actor({ membershipId: MEMBERSHIP_OLD }),
          }),
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(inserts, []);
  });

  void it('does not attach a usable secret to thrown errors', async () => {
    const { create } = commandOf({
      pending: { id: '018f1e2c-7e3a-7000-8000-1234567890ff' },
    });
    await assert.rejects(async () => {
      try {
        await create(input());
      } catch (error) {
        assert.equal(
          error instanceof Error && error.message.includes(SECRET.encoded),
          false,
        );
        assert.equal(JSON.stringify(error).includes(SECRET.encoded), false);
        throw error;
      }
    }, InvitationAlreadyPendingError);
    void OTHER_HOME;
  });
});

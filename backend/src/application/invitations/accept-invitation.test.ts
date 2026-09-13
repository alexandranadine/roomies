import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LockedHomeEntryStructure } from '../../domains/homes/index.js';
import {
  AlreadyHomeMemberError,
  InvitationEmailMismatchError,
  InvitationEmailNotVerifiedError,
  InvitationNotAvailableError,
} from '../../domains/invitations/errors.js';
import type { Invitation } from '../../domains/invitations/invitation.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
  invitationTokenHashesEqual,
} from '../../domains/invitations/secret.js';
import type {
  NewInvitationMembership,
  PriorMembershipTenure,
} from '../../domains/memberships/index.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import type {
  JsonObject,
  OutboxEventInput,
} from '../../platform/events/outbox-types.js';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import {
  createAcceptInvitation,
  type AcceptInvitationDependencies,
} from './accept-invitation.js';

const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const CREATOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW_MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';
const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ad';
const NOW = new Date('2026-10-02T00:00:00.000Z');
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');
const SECRET = generateInvitationSecret();
const WRONG_SECRET = generateInvitationSecret();
const TX: TransactionContext = {
  query: () => Promise.reject(new Error('unexpected direct query')),
};

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return Object.freeze({
    id: INVITATION_ID,
    homeId: HOME_ID,
    invitedEmail: normalizeEmail('roommate@example.com'),
    tokenHash: hashInvitationSecretBytes(SECRET.bytes),
    createdByMembershipId: CREATOR_ID,
    createdAt: CREATED_AT,
    expiresAt: new Date('2026-10-08T00:00:00.000Z'),
    acceptedAt: null,
    acceptedMembershipId: null,
    revokedAt: null,
    revocationCause: null,
    ...overrides,
  });
}

function lockedHome(
  activeUserIds: readonly string[] = [ADMIN_ID],
  archived = false,
): LockedHomeEntryStructure {
  return {
    home: { id: HOME_ID, archived },
    activeMemberships: activeUserIds.map((userId, index) => ({
      id:
        index === 0
          ? CREATOR_ID
          : `dddddddd-dddd-4ddd-8ddd-ddddddddddd${index}`,
      homeId: HOME_ID,
      userId,
      role: index === 0 ? 'ADMIN' : 'ROOMMATE',
    })),
  };
}

type HarnessOptions = {
  preread?: Invitation | null;
  authoritative?: Invitation | null;
  home?: LockedHomeEntryStructure;
  email?: string;
  verified?: boolean;
  identityMissing?: boolean;
  prior?: PriorMembershipTenure | null;
  acceptCount?: number;
  insertError?: Error;
  outboxError?: Error;
};

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const inserted: NewInvitationMembership[] = [];
  const events: OutboxEventInput<string, JsonObject>[] = [];
  let idIndex = 0;
  let clockCalls = 0;
  let findCalls = 0;

  const deps: AcceptInvitationDependencies = {
    runTransaction: async (work) => {
      order.push('begin');
      const result = await work(TX);
      order.push('commit');
      return result;
    },
    invitations: {
      findById: () => {
        order.push('preread');
        findCalls += 1;
        return Promise.resolve(
          options.preread === undefined ? invitation() : options.preread,
        );
      },
      lockById: () => {
        order.push('invitation-lock');
        return Promise.resolve(
          options.authoritative === undefined
            ? invitation()
            : options.authoritative,
        );
      },
      acceptLocked: () => {
        order.push('invitation-accept');
        return Promise.resolve(options.acceptCount ?? 1);
      },
    },
    lockHomeStructure: () => {
      order.push('home-memberships-lock');
      return Promise.resolve(options.home ?? lockedHome());
    },
    findCurrentIdentity: () => {
      order.push('identity');
      if (options.identityMissing === true) return Promise.resolve(null);
      return Promise.resolve({
        userId: USER_ID,
        email: normalizeEmail(options.email ?? 'roommate@example.com'),
        emailVerified: options.verified ?? true,
      });
    },
    findLatestEndedTenure: () => {
      order.push('history');
      return Promise.resolve(options.prior ?? null);
    },
    insertMembership: (_tx, membership) => {
      order.push('membership-insert');
      if (options.insertError) return Promise.reject(options.insertError);
      inserted.push(membership);
      return Promise.resolve();
    },
    outbox: {
      append: (_tx, event) => {
        order.push('outbox');
        if (options.outboxError) return Promise.reject(options.outboxError);
        events.push(event);
        return Promise.resolve();
      },
    },
    clock: {
      now: () => {
        clockCalls += 1;
        return NOW;
      },
    },
    ids: {
      next: () => {
        const id = [NEW_MEMBERSHIP_ID, EVENT_ID][idIndex];
        idIndex += 1;
        if (id === undefined) throw new Error('unexpected id request');
        return id;
      },
    },
    hashesEqual: invitationTokenHashesEqual,
  };

  const command = createAcceptInvitation(deps);
  return {
    run: (secret = SECRET.encoded) =>
      command({ invitationId: INVITATION_ID, userId: USER_ID, secret }),
    order,
    inserted,
    events,
    get clockCalls() {
      return clockCalls;
    },
    get findCalls() {
      return findCalls;
    },
  };
}

async function rejectsWith<T extends Error>(
  promise: Promise<unknown>,
  error: new () => T,
): Promise<T> {
  try {
    await promise;
    assert.fail('expected rejection');
  } catch (caught) {
    assert.ok(caught instanceof error);
    return caught;
  }
}

void describe('acceptInvitation', () => {
  void it('creates one fresh ROOMMATE tenure and exact started event', async () => {
    const test = harness();
    const result = await test.run();

    assert.deepEqual(result, {
      membershipId: NEW_MEMBERSHIP_ID,
      homeId: HOME_ID,
    });
    assert.deepEqual(test.inserted, [
      {
        id: NEW_MEMBERSHIP_ID,
        homeId: HOME_ID,
        userId: USER_ID,
        joinedAt: NOW,
      },
    ]);
    assert.equal(test.clockCalls, 1);
    assert.deepEqual(test.events, [
      {
        eventId: EVENT_ID,
        eventType: 'membership.started.v1',
        occurredAt: NOW,
        homeId: HOME_ID,
        payload: {
          membershipId: NEW_MEMBERSHIP_ID,
          cause: 'INVITATION_ACCEPTED',
          invitationId: INVITATION_ID,
        },
      },
    ]);
    assert.equal(JSON.stringify(test.events).includes(SECRET.encoded), false);
    assert.equal(JSON.stringify(test.events).includes('email'), false);
    assert.equal(JSON.stringify(test.events).includes('token'), false);
    assert.deepEqual(test.order, [
      'preread',
      'begin',
      'home-memberships-lock',
      'invitation-lock',
      'identity',
      'history',
      'membership-insert',
      'invitation-accept',
      'outbox',
      'commit',
    ]);
  });

  void it('keeps former ADMIN history unchanged and rejoins with a new id', async () => {
    const oldTenure: PriorMembershipTenure = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      role: 'ADMIN',
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: CREATED_AT,
    };
    const snapshot = structuredClone(oldTenure);
    const test = harness({ prior: oldTenure });

    await test.run();
    assert.deepEqual(oldTenure, snapshot);
    assert.notEqual(test.inserted[0]?.id, oldTenure.id);
    assert.equal('role' in (test.inserted[0] ?? {}), false);
  });

  void it('rejects unverified and mismatched current canonical email', async () => {
    await rejectsWith(
      harness({ verified: false }).run(),
      InvitationEmailNotVerifiedError,
    );
    await rejectsWith(
      harness({ email: 'other@example.com' }).run(),
      InvitationEmailMismatchError,
    );
  });

  void it('fails closed when the canonical identity invariant is missing', async () => {
    const error = await rejectsWith(
      harness({ identityMissing: true }).run(),
      Error,
    );
    assert.equal(error.name, 'StructuralIntegrityError');
    assert.equal(error.message.includes('roommate@example.com'), false);
  });

  void it('rejects an already-active user without accepting the invitation', async () => {
    const test = harness({ home: lockedHome([ADMIN_ID, USER_ID]) });
    await rejectsWith(test.run(), AlreadyHomeMemberError);
    assert.deepEqual(test.inserted, []);
    assert.equal(test.order.includes('invitation-accept'), false);
  });

  void it('uniformly rejects unknown, wrong, malformed, expired, revoked, and accepted invitations', async () => {
    const unavailableRuns = [
      harness({ preread: null }).run(),
      harness().run(WRONG_SECRET.encoded),
      harness().run('not-32-bytes' as typeof SECRET.encoded),
      harness({
        authoritative: invitation({
          expiresAt: NOW,
        }),
      }).run(),
      harness({
        authoritative: invitation({
          revokedAt: new Date('2026-10-01T12:00:00.000Z'),
          revocationCause: 'ADMIN_REVOKED',
        }),
      }).run(),
      harness({
        authoritative: invitation({
          acceptedAt: new Date('2026-10-01T12:00:00.000Z'),
          acceptedMembershipId: NEW_MEMBERSHIP_ID,
        }),
      }).run(),
      harness({ home: lockedHome([ADMIN_ID], true) }).run(),
    ];
    for (const run of unavailableRuns) {
      const error = await rejectsWith(run, InvitationNotAvailableError);
      assert.equal(error.message.includes(SECRET.encoded), false);
      assert.equal(error.message.includes('stale'), false);
    }
  });

  void it('revalidates authoritative token after the preread', async () => {
    const changed = invitation({
      tokenHash: hashInvitationSecretBytes(WRONG_SECRET.bytes),
    });
    const test = harness({ authoritative: changed });
    await rejectsWith(test.run(), InvitationNotAvailableError);
    assert.deepEqual(test.order, [
      'preread',
      'begin',
      'home-memberships-lock',
      'invitation-lock',
    ]);
  });

  void it('rejects only invitations strictly before the latest tenure end', async () => {
    const before = harness({
      prior: {
        id: CREATOR_ID,
        role: 'ROOMMATE',
        joinedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: new Date(CREATED_AT.getTime() + 1),
      },
    });
    await rejectsWith(before.run(), InvitationNotAvailableError);

    await harness({
      prior: {
        id: CREATOR_ID,
        role: 'ADMIN',
        joinedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: CREATED_AT,
      },
    }).run();
    await harness({
      prior: {
        id: CREATOR_ID,
        role: 'ADMIN',
        joinedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: new Date(CREATED_AT.getTime() - 1),
      },
    }).run();
  });

  void it('does not proceed when the terminal invitation update is lost', async () => {
    const test = harness({ acceptCount: 0 });
    const error = await rejectsWith(test.run(), Error);
    assert.equal(error.name, 'StructuralIntegrityError');
    assert.equal(test.order.includes('outbox'), false);
  });

  void it('propagates insert and outbox failure so the transaction owner rolls back', async () => {
    const insertFailure = new Error('insert failed');
    const insert = harness({ insertError: insertFailure });
    await assert.rejects(insert.run(), (error) => error === insertFailure);
    assert.equal(insert.order.includes('invitation-accept'), false);

    const outboxFailure = new Error('outbox failed');
    const outbox = harness({ outboxError: outboxFailure });
    await assert.rejects(outbox.run(), (error) => error === outboxFailure);
    assert.equal(outbox.order.includes('commit'), false);
  });
});

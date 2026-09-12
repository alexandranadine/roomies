import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Home } from '../../domains/homes/home.js';
import { InvitationNotAvailableError } from '../../domains/invitations/errors.js';
import type { Invitation } from '../../domains/invitations/invitation.js';
import {
  generateInvitationSecret,
  hashInvitationSecretBytes,
  invitationTokenHashesEqual,
} from '../../domains/invitations/secret.js';
import { invitationTokenHash } from '../../domains/invitations/token-hash.js';
import { normalizeEmail } from '../../platform/auth/index.js';
import {
  createPreviewInvitation,
  type PreviewInvitationInput,
} from './preview-invitation.js';

const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const OTHER_INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ac';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-10-02T00:00:00.000Z');
const SECRET = generateInvitationSecret();
const OTHER_SECRET = generateInvitationSecret();

function pendingInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return Object.freeze({
    id: INVITATION_ID,
    homeId: HOME_ID,
    invitedEmail: normalizeEmail('Roommate@Example.com'),
    tokenHash: hashInvitationSecretBytes(SECRET.bytes),
    createdByMembershipId: MEMBERSHIP_ID,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    expiresAt: new Date('2026-10-08T00:00:00.000Z'),
    acceptedAt: null,
    acceptedMembershipId: null,
    revokedAt: null,
    revocationCause: null,
    ...overrides,
  });
}

function home(): Home {
  return Object.freeze({
    id: HOME_ID,
    name: 'Oak Street',
    timezone: 'America/Los_Angeles',
  });
}

function previewOf(options: {
  invitation?: Invitation | null;
  home?: Home | null;
  authorization?: string | null;
  invitationId?: string;
  hashesEqual?: typeof invitationTokenHashesEqual;
  findCalls?: string[];
  compareCalls?: Array<readonly [string, string]>;
}) {
  const findCalls = options.findCalls ?? [];
  const compareCalls = options.compareCalls ?? [];
  const hashesEqual = options.hashesEqual ?? invitationTokenHashesEqual;
  const command = createPreviewInvitation({
    invitations: {
      findById(invitationId) {
        findCalls.push(invitationId);
        return Promise.resolve(
          options.invitation === undefined
            ? pendingInvitation()
            : options.invitation,
        );
      },
    },
    homes: {
      findActiveHomeById() {
        return Promise.resolve(
          options.home === undefined ? home() : options.home,
        );
      },
    },
    clock: { now: () => NOW },
    hashesEqual: (left, right) => {
      compareCalls.push([
        Buffer.from(left).toString('hex'),
        Buffer.from(right).toString('hex'),
      ]);
      return hashesEqual(left, right);
    },
  });
  const input: PreviewInvitationInput = {
    invitationId: options.invitationId ?? INVITATION_ID,
    authorization:
      options.authorization === undefined
        ? `Invitation ${SECRET.encoded}`
        : (options.authorization ?? undefined),
  };
  return { command, input, findCalls, compareCalls };
}

async function expectUnavailable(
  run: () => Promise<unknown>,
): Promise<InvitationNotAvailableError> {
  try {
    await run();
    assert.fail('expected InvitationNotAvailableError');
  } catch (error) {
    assert.ok(error instanceof InvitationNotAvailableError);
    assert.equal(error.code, 'INVITATION_NOT_AVAILABLE');
    assert.equal(error.message.includes(SECRET.encoded), false);
    assert.equal(error.message.includes('token'), false);
    assert.equal(error.message.includes(MEMBERSHIP_ID), false);
    return error;
  }
}

void describe('previewInvitation', () => {
  void it('returns safe pending preview metadata', async () => {
    const { command, input, compareCalls } = previewOf({});
    const result = await command(input);
    assert.deepEqual(result, {
      invitation: {
        id: INVITATION_ID,
        email: 'roommate@example.com',
        expiresAt: new Date('2026-10-08T00:00:00.000Z'),
        home: { id: HOME_ID, name: 'Oak Street' },
      },
    });
    assert.equal('timezone' in result.invitation.home, false);
    assert.equal('tokenHash' in result.invitation, false);
    assert.equal('createdByMembershipId' in result.invitation, false);
    assert.equal('acceptedMembershipId' in result.invitation, false);
    assert.equal(compareCalls.length, 1);
  });

  void it('uses the constant-time digest helper before exposing metadata', async () => {
    const source = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'preview-invitation.ts',
      ),
      'utf8',
    );
    assert.match(source, /hashesEqual: invitationTokenHashesEqual/);
    assert.match(source, /deps\.hashesEqual\(supplied, stored\)/);
  });

  void it('compares the digest even when the invitation id is unknown', async () => {
    const { command, input, compareCalls } = previewOf({ invitation: null });
    await expectUnavailable(() => command(input));
    assert.equal(compareCalls.length, 1);
    assert.equal(
      compareCalls[0]?.[1],
      Buffer.from(invitationTokenHash(new Uint8Array(32))).toString('hex'),
    );
  });

  void it('rejects a valid token for a different invitation', async () => {
    const { command, input } = previewOf({
      invitation: pendingInvitation({
        id: OTHER_INVITATION_ID,
        tokenHash: hashInvitationSecretBytes(OTHER_SECRET.bytes),
      }),
    });
    await expectUnavailable(() => command(input));
  });

  void it('maps malformed, missing, and wrong-scheme credentials to unavailable', async () => {
    for (const authorization of [
      null,
      '',
      `Bearer ${SECRET.encoded}`,
      `invitation ${SECRET.encoded}`,
      'Invitation',
      `Invitation ${SECRET.encoded} extra`,
      'Invitation not-32-bytes',
    ]) {
      const { command, input } = previewOf({ authorization });
      await expectUnavailable(() => command(input));
    }
  });

  void it('maps expired, accepted, and revoked invitations to unavailable', async () => {
    const expired = previewOf({
      invitation: pendingInvitation({
        expiresAt: new Date('2026-10-01T12:00:00.000Z'),
      }),
    });
    await expectUnavailable(() => expired.command(expired.input));

    const accepted = previewOf({
      invitation: pendingInvitation({
        acceptedAt: new Date('2026-10-01T12:00:00.000Z'),
        acceptedMembershipId: MEMBERSHIP_ID,
      }),
    });
    await expectUnavailable(() => accepted.command(accepted.input));

    const revoked = previewOf({
      invitation: pendingInvitation({
        revokedAt: new Date('2026-10-01T12:00:00.000Z'),
        revocationCause: 'ADMIN_REVOKED',
      }),
    });
    await expectUnavailable(() => revoked.command(revoked.input));
  });

  void it('does not expose Home metadata when the Home is archived or missing', async () => {
    const { command, input } = previewOf({ home: null });
    await expectUnavailable(() => command(input));
  });
});

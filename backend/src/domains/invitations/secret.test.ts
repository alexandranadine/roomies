import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { InvitationAlreadyPendingError } from './errors.js';
import {
  decodeInvitationSecret,
  generateInvitationSecret,
  hashInvitationSecretBytes,
  InvalidInvitationSecretError,
} from './secret.js';
import {
  InvalidInvitationTokenHashError,
  invitationTokenHash,
} from './token-hash.js';

void describe('invitation secret primitives', () => {
  void it('generates 32 random bytes encoded as unpadded base64url', () => {
    const generated = generateInvitationSecret();
    assert.equal(generated.bytes.byteLength, 32);
    assert.doesNotMatch(generated.encoded, /[+/=]/);
    assert.match(generated.encoded, /^[A-Za-z0-9_-]+$/);
    const decoded = decodeInvitationSecret(generated.encoded);
    assert.equal(decoded.byteLength, 32);
    assert.deepEqual([...decoded], [...generated.bytes]);
  });

  void it('generates distinct secrets', () => {
    const first = generateInvitationSecret();
    const second = generateInvitationSecret();
    assert.notEqual(first.encoded, second.encoded);
    assert.notDeepEqual([...first.bytes], [...second.bytes]);
  });

  void it('hashes raw secret bytes to a 32-byte digest', () => {
    const generated = generateInvitationSecret();
    const digest = hashInvitationSecretBytes(generated.bytes);
    assert.equal(digest.byteLength, 32);
    const expected = createHash('sha256').update(generated.bytes).digest();
    assert.deepEqual([...digest], [...expected]);
  });

  void it('hashes a known secret deterministically', () => {
    const bytes = new Uint8Array(32).fill(7);
    const first = hashInvitationSecretBytes(bytes);
    const second = hashInvitationSecretBytes(bytes);
    assert.deepEqual([...first], [...second]);
    assert.deepEqual(
      [...first],
      [...createHash('sha256').update(bytes).digest()],
    );
  });

  void it('keeps the raw secret out of the persistence object', () => {
    const generated = generateInvitationSecret();
    const persistence = Object.freeze({
      id: '018f1e2c-7e3a-7000-8000-1234567890ab',
      homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      invitedEmail: 'roommate@example.com',
      tokenHash: hashInvitationSecretBytes(generated.bytes),
      createdByMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: new Date('2026-10-08T00:00:00.000Z'),
    });
    assert.equal('rawSecret' in persistence, false);
    assert.equal('encoded' in persistence, false);
    assert.equal(
      JSON.stringify(persistence).includes(generated.encoded),
      false,
    );
    assert.equal(persistence.tokenHash.byteLength, 32);
  });

  void it('rejects malformed digests and keeps secrets out of errors', () => {
    assert.throws(
      () => invitationTokenHash(new Uint8Array(31)),
      InvalidInvitationTokenHashError,
    );
    assert.throws(
      () => decodeInvitationSecret('not-a-32-byte-secret'),
      InvalidInvitationSecretError,
    );
    const generated = generateInvitationSecret();
    const error = new InvitationAlreadyPendingError();
    assert.equal(error.message.includes(generated.encoded), false);
    assert.equal(JSON.stringify(error).includes(generated.encoded), false);
    assert.equal(
      String(new InvalidInvitationSecretError()).includes(generated.encoded),
      false,
    );
  });
});

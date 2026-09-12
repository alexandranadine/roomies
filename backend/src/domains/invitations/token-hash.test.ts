import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InvalidInvitationTokenHashError,
  invitationTokenHash,
} from './token-hash.js';

void describe('invitationTokenHash', () => {
  void it('accepts and copies exactly 32 bytes', () => {
    const input = new Uint8Array(32).fill(7);
    const digest = invitationTokenHash(input);
    input[0] = 9;
    assert.equal(digest.byteLength, 32);
    assert.equal(digest[0], 7);
  });

  void it('rejects every other digest length', () => {
    assert.throws(
      () => invitationTokenHash(new Uint8Array(31)),
      InvalidInvitationTokenHashError,
    );
    assert.throws(
      () => invitationTokenHash(new Uint8Array(33)),
      InvalidInvitationTokenHashError,
    );
  });
});

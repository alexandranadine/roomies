import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InvalidInvitationAuthorizationError,
  parseInvitationAuthorization,
} from './bearer.js';
import { generateInvitationSecret } from './secret.js';

const VALID = generateInvitationSecret().encoded;

void describe('parseInvitationAuthorization', () => {
  void it('accepts exactly Invitation plus one base64url secret', () => {
    assert.equal(parseInvitationAuthorization(`Invitation ${VALID}`), VALID);
  });

  void it('rejects missing, empty, and non-string headers', () => {
    assert.throws(
      () => parseInvitationAuthorization(undefined),
      InvalidInvitationAuthorizationError,
    );
    assert.throws(
      () => parseInvitationAuthorization(''),
      InvalidInvitationAuthorizationError,
    );
  });

  void it('rejects scheme case variants and Bearer fallback', () => {
    for (const header of [
      `invitation ${VALID}`,
      `INVITATION ${VALID}`,
      `Bearer ${VALID}`,
      `bearer ${VALID}`,
      `Basic ${VALID}`,
    ]) {
      assert.throws(
        () => parseInvitationAuthorization(header),
        InvalidInvitationAuthorizationError,
      );
    }
  });

  void it('rejects missing secret, extra whitespace, and multiple credentials', () => {
    for (const header of [
      'Invitation',
      'Invitation ',
      `Invitation  ${VALID}`,
      `Invitation\t${VALID}`,
      ` Invitation ${VALID}`,
      `Invitation ${VALID} `,
      `Invitation ${VALID} extra`,
      `Invitation ${VALID}, Invitation ${VALID}`,
      `Invitation ${VALID},Bearer abc`,
    ]) {
      assert.throws(
        () => parseInvitationAuthorization(header),
        InvalidInvitationAuthorizationError,
      );
    }
  });

  void it('rejects secrets that are not unpadded base64url charset', () => {
    assert.throws(
      () => parseInvitationAuthorization('Invitation not a secret!'),
      InvalidInvitationAuthorizationError,
    );
    assert.throws(
      () => parseInvitationAuthorization('Invitation abc+def/ghi='),
      InvalidInvitationAuthorizationError,
    );
  });

  void it('does not put the secret in the error', () => {
    try {
      parseInvitationAuthorization(`Bearer ${VALID}`);
      assert.fail('expected InvalidInvitationAuthorizationError');
    } catch (error) {
      assert.ok(error instanceof InvalidInvitationAuthorizationError);
      assert.equal(error.message.includes(VALID), false);
      assert.equal(String(error).includes(VALID), false);
    }
  });
});

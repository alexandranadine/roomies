import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createUuidV7 } from './uuid-v7.js';

void describe('createUuidV7', () => {
  void it('returns RFC text form with version 7 and RFC 4122 variant', () => {
    const id = createUuidV7(1_710_000_000_000);
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

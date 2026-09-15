import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { currentUserDtoSchema, toCurrentUserDto } from './current-user-dto.js';

void describe('currentUserDto', () => {
  void it('whitelists only the canonical User id', () => {
    assert.deepEqual(toCurrentUserDto({ id: 'user-1' }), { id: 'user-1' });
  });

  void it('rejects deletion markers on the ordinary current-user DTO', () => {
    assert.throws(() =>
      currentUserDtoSchema.parse({
        id: 'user-1',
        deletedAt: '2026-09-14T21:00:00.000Z',
      }),
    );
    assert.throws(() =>
      currentUserDtoSchema.parse({
        id: 'user-1',
        deleted_at: '2026-09-14T21:00:00.000Z',
      }),
    );
  });
});

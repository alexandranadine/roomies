import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toHomeDto } from './home-dto.js';

void describe('toHomeDto', () => {
  void it('whitelists id, name, and timezone', () => {
    assert.deepEqual(
      toHomeDto({
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
      }),
      {
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
      },
    );
  });

  void it('does not copy Membership, role, or archive fields', () => {
    const leaked = {
      id: 'home-1',
      name: 'Oak Street',
      timezone: 'UTC',
      membershipId: 'membership-secret',
      role: 'ADMIN',
      archivedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    assert.deepEqual(toHomeDto(leaked), {
      id: 'home-1',
      name: 'Oak Street',
      timezone: 'UTC',
    });
    const serialized = JSON.stringify(toHomeDto(leaked));
    assert.equal(serialized.includes('membership'), false);
    assert.equal(serialized.includes('ADMIN'), false);
    assert.equal(serialized.includes('archived'), false);
    assert.equal(serialized.includes('createdAt'), false);
  });
});

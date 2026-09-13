import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toCreatedHomeDto } from './created-home-dto.js';

void describe('toCreatedHomeDto', () => {
  void it('whitelists home cosmetics and founding membership id/role only', () => {
    const dto = toCreatedHomeDto({
      home: {
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
      },
      membership: { id: 'membership-1', role: 'ADMIN' },
    });
    assert.deepEqual(dto, {
      home: {
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
      },
      membership: { id: 'membership-1', role: 'ADMIN' },
    });
    assert.deepEqual(Object.keys(dto), ['home', 'membership']);
    assert.deepEqual(Object.keys(dto.home), ['id', 'name', 'timezone']);
    assert.deepEqual(Object.keys(dto.membership), ['id', 'role']);
  });

  void it('does not copy Owner, archive, or tenure timestamp fields', () => {
    const leaked = {
      home: {
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'UTC',
        ownerId: 'owner-secret',
        createdByUserId: 'creator-secret',
        primaryAdmin: true,
        archivedAt: '2026-01-01T00:00:00.000Z',
      },
      membership: {
        id: 'membership-1',
        role: 'ADMIN' as const,
        founder: true,
        joinedAt: '2026-01-01T00:00:00.000Z',
        userId: 'user-secret',
      },
    };
    const dto = toCreatedHomeDto(leaked);
    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes('owner'), false);
    assert.equal(serialized.includes('createdBy'), false);
    assert.equal(serialized.includes('primaryAdmin'), false);
    assert.equal(serialized.includes('founder'), false);
    assert.equal(serialized.includes('archived'), false);
    assert.equal(serialized.includes('joinedAt'), false);
    assert.equal(serialized.includes('userId'), false);
  });
});

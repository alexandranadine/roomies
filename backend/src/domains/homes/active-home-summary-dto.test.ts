import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  toActiveHomeSummaryDto,
  toActiveHomesDto,
} from './active-home-summary-dto.js';

void describe('toActiveHomeSummaryDto', () => {
  void it('whitelists id, name, timezone, and current role', () => {
    assert.deepEqual(
      toActiveHomeSummaryDto({
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        role: 'ADMIN',
      }),
      {
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        role: 'ADMIN',
      },
    );
  });

  void it('does not copy Membership ids, archive fields, or invitation state', () => {
    const leaked = {
      id: 'home-1',
      name: 'Oak Street',
      timezone: 'UTC',
      role: 'ROOMMATE' as const,
      membershipId: 'membership-secret',
      membership: {
        id: 'membership-secret',
        endedAt: '2026-01-01T00:00:00.000Z',
      },
      archivedAt: '2026-01-01T00:00:00.000Z',
      invitationId: 'invitation-secret',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const dto = toActiveHomeSummaryDto(leaked);
    assert.deepEqual(dto, {
      id: 'home-1',
      name: 'Oak Street',
      timezone: 'UTC',
      role: 'ROOMMATE',
    });
    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes('membership'), false);
    assert.equal(serialized.includes('archived'), false);
    assert.equal(serialized.includes('invitation'), false);
    assert.equal(serialized.includes('createdAt'), false);
  });

  void it('serializes a list without wrapping extra collections', () => {
    assert.deepEqual(
      toActiveHomesDto([
        {
          id: 'home-1',
          name: 'Cedar',
          timezone: 'UTC',
          role: 'ROOMMATE',
        },
      ]),
      [
        {
          id: 'home-1',
          name: 'Cedar',
          timezone: 'UTC',
          role: 'ROOMMATE',
        },
      ],
    );
  });
});

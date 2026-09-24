import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  toActiveHomeSummaryDto,
  toActiveHomesDto,
} from './active-home-summary-dto.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHOTO_OBJECT_KEY = `homes/${HOME_ID}/photo/11111111-1111-4111-8111-111111111111.webp`;

void describe('toActiveHomeSummaryDto', () => {
  void it('whitelists id, name, timezone, current role, and hasPhoto', () => {
    assert.deepEqual(
      toActiveHomeSummaryDto({
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        role: 'ADMIN',
        photoObjectKey: null,
      }),
      {
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        role: 'ADMIN',
        hasPhoto: false,
      },
    );
  });

  void it('does not copy Membership ids, archive fields, invitation state, or object keys', () => {
    const leaked = {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      role: 'ROOMMATE' as const,
      photoObjectKey: PHOTO_OBJECT_KEY,
      membershipId: 'membership-secret',
      membership: {
        id: 'membership-secret',
        endedAt: '2026-01-01T00:00:00.000Z',
      },
      archivedAt: '2026-01-01T00:00:00.000Z',
      invitationId: 'invitation-secret',
      createdAt: '2026-01-01T00:00:00.000Z',
      photo_object_key: PHOTO_OBJECT_KEY,
    };
    const dto = toActiveHomeSummaryDto(leaked);
    assert.deepEqual(dto, {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      role: 'ROOMMATE',
      hasPhoto: true,
    });
    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes('membership'), false);
    assert.equal(serialized.includes('archived'), false);
    assert.equal(serialized.includes('invitation'), false);
    assert.equal(serialized.includes('createdAt'), false);
    assert.equal(serialized.includes('photoObjectKey'), false);
    assert.equal(serialized.includes('photo_object_key'), false);
    assert.equal(serialized.includes(PHOTO_OBJECT_KEY), false);
  });

  void it('serializes a list without wrapping extra collections', () => {
    assert.deepEqual(
      toActiveHomesDto([
        {
          id: 'home-1',
          name: 'Cedar',
          timezone: 'UTC',
          role: 'ROOMMATE',
          photoObjectKey: null,
        },
      ]),
      [
        {
          id: 'home-1',
          name: 'Cedar',
          timezone: 'UTC',
          role: 'ROOMMATE',
          hasPhoto: false,
        },
      ],
    );
  });
});

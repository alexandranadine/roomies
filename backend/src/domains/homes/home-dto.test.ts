import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toHomeDto } from './home-dto.js';

const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION_ID = '11111111-1111-4111-8111-111111111111';
const PHOTO_OBJECT_KEY = `homes/${HOME_ID}/photo/${GENERATION_ID}.webp`;

void describe('toHomeDto', () => {
  void it('whitelists id, name, timezone, and hasPhoto', () => {
    assert.deepEqual(
      toHomeDto({
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        photoObjectKey: null,
      }),
      {
        id: 'home-1',
        name: 'Oak Street',
        timezone: 'America/Los_Angeles',
        hasPhoto: false,
      },
    );
    assert.deepEqual(
      toHomeDto({
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'UTC',
        photoObjectKey: PHOTO_OBJECT_KEY,
      }),
      {
        id: HOME_ID,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: true,
      },
    );
  });

  void it('does not copy Membership, role, archive, or object-store fields', () => {
    const leaked = {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      photoObjectKey: PHOTO_OBJECT_KEY,
      membershipId: 'membership-secret',
      role: 'ADMIN',
      archivedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      photo_object_key: PHOTO_OBJECT_KEY,
      mediaUrl: `https://cdn.example/${PHOTO_OBJECT_KEY}`,
    };
    const dto = toHomeDto(leaked);
    assert.deepEqual(dto, {
      id: HOME_ID,
      name: 'Oak Street',
      timezone: 'UTC',
      hasPhoto: true,
    });
    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes('membership'), false);
    assert.equal(serialized.includes('ADMIN'), false);
    assert.equal(serialized.includes('archived'), false);
    assert.equal(serialized.includes('createdAt'), false);
    assert.equal(serialized.includes('photoObjectKey'), false);
    assert.equal(serialized.includes('photo_object_key'), false);
    assert.equal(serialized.includes(PHOTO_OBJECT_KEY), false);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('cdn.example'), false);
    assert.equal('photoObjectKey' in dto, false);
    assert.equal('photo_object_key' in dto, false);
  });
});

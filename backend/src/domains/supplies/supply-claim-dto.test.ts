import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SupplyClaim } from './supply.js';
import { toSupplyClaimDto } from './supply-claim-dto.js';

const CLAIMED = new Date('2026-09-12T19:00:00.000Z');

function claim(overrides: Partial<SupplyClaim> = {}): SupplyClaim {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ad',
    homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    supplyEntryId: '018f1e2c-7e3a-7000-8000-1234567890ab',
    claimantMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    claimedAt: CLAIMED,
    releasedAt: null,
    releaseReason: null,
    createdAt: CLAIMED,
    updatedAt: CLAIMED,
    ...overrides,
  };
}

void describe('toSupplyClaimDto', () => {
  void it('whitelists the safe claim snapshot only', () => {
    const dto = toSupplyClaimDto(claim());
    assert.deepEqual(dto, {
      id: '018f1e2c-7e3a-7000-8000-1234567890ad',
      supplyEntryId: '018f1e2c-7e3a-7000-8000-1234567890ab',
      claimantMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      claimedAt: CLAIMED.toISOString(),
      releasedAt: null,
      releaseReason: null,
    });
    assert.deepEqual(Object.keys(dto), [
      'id',
      'supplyEntryId',
      'claimantMembershipId',
      'claimedAt',
      'releasedAt',
      'releaseReason',
    ]);
  });

  void it('does not copy Home, user, or persistence internals', () => {
    const leaked = claim({
      homeId: 'home-secret',
    }) as SupplyClaim & { userId: string; profileName: string };
    leaked.userId = 'user-secret';
    leaked.profileName = 'Name Leak';
    const serialized = JSON.stringify(toSupplyClaimDto(leaked));
    assert.equal(serialized.includes('home-secret'), false);
    assert.equal(serialized.includes('user-secret'), false);
    assert.equal(serialized.includes('Name Leak'), false);
    assert.equal(serialized.includes('homeId'), false);
    assert.equal(serialized.includes('userId'), false);
    assert.equal(serialized.includes('createdAt'), false);
    assert.equal(serialized.includes('updatedAt'), false);
  });
});

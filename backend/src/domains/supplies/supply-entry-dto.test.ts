import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ListedSupplyEntry, SupplyEntry } from './supply.js';
import { toSupplyEntryDto, toSupplyEntryListDto } from './supply-entry-dto.js';

const CREATED = new Date('2026-09-12T18:00:00.000Z');
const CLAIMED = new Date('2026-09-12T19:00:00.000Z');

function entry(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Paper towels',
    status: 'OPEN',
    createdByMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    obtainedAt: null,
    obtainedByMembershipId: null,
    canceledAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

void describe('toSupplyEntryDto', () => {
  void it('whitelists the safe SupplyEntry snapshot and null activeClaim', () => {
    const dto = toSupplyEntryDto(entry());
    assert.deepEqual(dto, {
      id: '018f1e2c-7e3a-7000-8000-1234567890ab',
      title: 'Paper towels',
      status: 'OPEN',
      createdByMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      obtainedAt: null,
      canceledAt: null,
      createdAt: CREATED.toISOString(),
      updatedAt: CREATED.toISOString(),
      activeClaim: null,
    });
    assert.deepEqual(Object.keys(dto), [
      'id',
      'title',
      'status',
      'createdByMembershipId',
      'obtainedAt',
      'canceledAt',
      'createdAt',
      'updatedAt',
      'activeClaim',
    ]);
  });

  void it('projects only claimant Membership and claimedAt', () => {
    const dto = toSupplyEntryDto(entry(), {
      claimantMembershipId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      claimedAt: CLAIMED,
    });
    assert.deepEqual(dto.activeClaim, {
      claimantMembershipId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      claimedAt: CLAIMED.toISOString(),
    });
    assert.deepEqual(Object.keys(dto.activeClaim ?? {}), [
      'claimantMembershipId',
      'claimedAt',
    ]);
  });

  void it('does not copy Home or extra claim fields', () => {
    const leaked = entry({
      homeId: 'home-secret',
    }) as SupplyEntry & {
      claimedBy: string;
      canClaim: boolean;
      userId: string;
    };
    leaked.claimedBy = 'claimant-secret';
    leaked.canClaim = true;
    leaked.userId = 'user-secret';
    const serialized = JSON.stringify(
      toSupplyEntryDto(leaked, {
        claimantMembershipId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        claimedAt: CLAIMED,
      }),
    );
    assert.equal(serialized.includes('home-secret'), false);
    assert.equal(serialized.includes('claimant-secret'), false);
    assert.equal(serialized.includes('user-secret'), false);
    assert.equal(serialized.includes('homeId'), false);
    assert.equal(serialized.includes('obtainedByMembershipId'), false);
    assert.equal(serialized.includes('claimedBy'), false);
    assert.equal(serialized.includes('canClaim'), false);
    assert.equal(serialized.includes('userId'), false);
    assert.equal(serialized.includes('"id"'), true);
    assert.equal(serialized.includes('releaseReason'), false);
  });

  void it('maps a list without adding collection metadata', () => {
    const listed: ListedSupplyEntry[] = [
      { ...entry(), activeClaim: null },
      { ...entry({ id: 'other' }), activeClaim: null },
    ];
    const mapped = toSupplyEntryListDto(listed);
    assert.equal(mapped.length, 2);
    assert.equal(Array.isArray(mapped), true);
    assert.equal(mapped[0]?.activeClaim, null);
  });
});

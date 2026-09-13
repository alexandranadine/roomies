import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SupplyEntry } from './supply.js';
import { toSupplyEntryDto, toSupplyEntryListDto } from './supply-entry-dto.js';

const CREATED = new Date('2026-09-12T18:00:00.000Z');

function entry(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Paper towels',
    status: 'OPEN',
    createdByMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    obtainedAt: null,
    canceledAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

void describe('toSupplyEntryDto', () => {
  void it('whitelists the safe SupplyEntry snapshot only', () => {
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
    ]);
  });

  void it('does not copy Home or claim fields', () => {
    const leaked = entry({
      homeId: 'home-secret',
    }) as SupplyEntry & {
      activeClaim: string;
      claimedBy: string;
      canClaim: boolean;
      userId: string;
    };
    leaked.activeClaim = 'claim-secret';
    leaked.claimedBy = 'claimant-secret';
    leaked.canClaim = true;
    leaked.userId = 'user-secret';
    const serialized = JSON.stringify(toSupplyEntryDto(leaked));
    assert.equal(serialized.includes('home-secret'), false);
    assert.equal(serialized.includes('claim-secret'), false);
    assert.equal(serialized.includes('claimant-secret'), false);
    assert.equal(serialized.includes('user-secret'), false);
    assert.equal(serialized.includes('homeId'), false);
    assert.equal(serialized.includes('activeClaim'), false);
    assert.equal(serialized.includes('claimedBy'), false);
    assert.equal(serialized.includes('canClaim'), false);
    assert.equal(serialized.includes('userId'), false);
  });

  void it('maps a list without adding collection metadata', () => {
    const listed = toSupplyEntryListDto([entry(), entry({ id: 'other' })]);
    assert.equal(listed.length, 2);
    assert.equal(Array.isArray(listed), true);
  });
});

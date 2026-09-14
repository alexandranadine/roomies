import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHomeLocalDate } from '../tasks/home-local-date.js';
import type { HousePulse } from './house-pulse.js';
import { housePulseDtoSchema, toHousePulseDto } from './house-pulse-dto.js';

const GENERATED = new Date('2026-09-14T07:00:00.000Z');

function pulse(): HousePulse {
  return {
    generatedAt: GENERATED,
    homeLocalDate: parseHomeLocalDate('2026-09-14'),
    items: [
      {
        type: 'TASKS',
        state: 'ACTIVE',
        assignedOpenCount: 1,
        unassignedOpenCount: 0,
        dueTodayRelevantCount: 1,
        overdueRelevantCount: 0,
      },
      {
        type: 'SUPPLIES',
        state: 'CLEAR',
        openCount: 0,
        unclaimedOpenCount: 0,
        claimedByMeCount: 0,
      },
      {
        type: 'MAINTENANCE',
        state: 'ACTIVE',
        openVisibleCount: 2,
      },
    ],
  };
}

void describe('toHousePulseDto', () => {
  void it('whitelists generatedAt, homeLocalDate, and the three section items', () => {
    const dto = toHousePulseDto(pulse());
    assert.deepEqual(Object.keys(dto), [
      'generatedAt',
      'homeLocalDate',
      'items',
    ]);
    assert.equal(dto.generatedAt, '2026-09-14T07:00:00.000Z');
    assert.equal(dto.homeLocalDate, '2026-09-14');
    assert.equal(dto.items.length, 3);
    assert.deepEqual(
      dto.items.map((item) => item.type),
      ['TASKS', 'SUPPLIES', 'MAINTENANCE'],
    );
    assert.deepEqual(Object.keys(dto.items[0] ?? {}), [
      'type',
      'state',
      'assignedOpenCount',
      'unassignedOpenCount',
      'dueTodayRelevantCount',
      'overdueRelevantCount',
    ]);
    assert.deepEqual(Object.keys(dto.items[1] ?? {}), [
      'type',
      'state',
      'openCount',
      'unclaimedOpenCount',
      'claimedByMeCount',
    ]);
    assert.deepEqual(Object.keys(dto.items[2] ?? {}), [
      'type',
      'state',
      'openVisibleCount',
    ]);
    assert.equal('id' in dto, false);
    assert.equal('membershipId' in dto, false);
    assert.equal('score' in dto, false);
    housePulseDtoSchema.parse(dto);
  });
});

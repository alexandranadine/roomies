import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHomeLocalDate } from './home-local-date.js';
import {
  toTaskDefinitionDto,
  toTaskDefinitionListDto,
} from './task-definition-dto.js';
import type { TaskDefinition } from './task-definition.js';

const CREATED = new Date('2026-09-12T18:00:00.000Z');

function definition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'Weekly trash',
    frequency: 'WEEKLY',
    weekday: 1,
    dayOfMonth: null,
    assignedMembershipId: null,
    creatorMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    nextOccurrenceDate: parseHomeLocalDate('2026-09-14'),
    nextOccurrenceAt: new Date('2026-09-14T00:00:00.000Z'),
    deactivatedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

void describe('toTaskDefinitionDto', () => {
  void it('exposes nextOccurrenceDate and never nextOccurrenceAt or homeId', () => {
    const dto = toTaskDefinitionDto(definition());
    assert.deepEqual(Object.keys(dto), [
      'id',
      'title',
      'frequency',
      'weekday',
      'dayOfMonth',
      'assignedMembershipId',
      'creatorMembershipId',
      'nextOccurrenceDate',
      'deactivatedAt',
      'createdAt',
      'updatedAt',
    ]);
    assert.equal(dto.nextOccurrenceDate, '2026-09-14');
    assert.equal('nextOccurrenceAt' in dto, false);
    assert.equal('homeId' in dto, false);
    const list = toTaskDefinitionListDto([definition()]);
    assert.equal(list.length, 1);
    assert.equal('nextOccurrenceAt' in (list[0] ?? {}), false);
  });
});

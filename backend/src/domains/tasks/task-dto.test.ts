import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TaskInstance } from './task.js';
import { toTaskDto, toTaskListDto } from './task-dto.js';

const CREATED = new Date('2026-09-12T18:00:00.000Z');

function task(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    homeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    source: 'MANUAL',
    status: 'OPEN',
    title: 'Take out trash',
    scheduledFor: '2026-09-15',
    assignedMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    completedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

void describe('toTaskDto', () => {
  void it('whitelists the safe Task snapshot only', () => {
    const dto = toTaskDto(task());
    assert.deepEqual(dto, {
      id: '018f1e2c-7e3a-7000-8000-1234567890ab',
      title: 'Take out trash',
      status: 'OPEN',
      source: 'MANUAL',
      scheduledFor: '2026-09-15',
      assignedMembershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: CREATED.toISOString(),
      updatedAt: CREATED.toISOString(),
    });
    assert.deepEqual(Object.keys(dto), [
      'id',
      'title',
      'status',
      'source',
      'scheduledFor',
      'assignedMembershipId',
      'createdAt',
      'updatedAt',
    ]);
  });

  void it('does not copy Home, definition, completion, or user identity fields', () => {
    const leaked = task({
      homeId: 'home-secret',
      completedAt: new Date('2026-09-13T00:00:00.000Z'),
    }) as TaskInstance & {
      taskDefinitionId: string;
      userId: string;
      recurrenceFrequency: string;
    };
    leaked.taskDefinitionId = 'definition-secret';
    leaked.userId = 'user-secret';
    leaked.recurrenceFrequency = 'DAILY';
    const serialized = JSON.stringify(toTaskDto(leaked));
    assert.equal(serialized.includes('home-secret'), false);
    assert.equal(serialized.includes('definition-secret'), false);
    assert.equal(serialized.includes('user-secret'), false);
    assert.equal(serialized.includes('DAILY'), false);
    assert.equal(serialized.includes('completedAt'), false);
    assert.equal(serialized.includes('homeId'), false);
    assert.equal(serialized.includes('taskDefinitionId'), false);
    assert.equal(serialized.includes('userId'), false);
  });

  void it('maps a list without adding collection metadata', () => {
    const listed = toTaskListDto([task(), task({ id: 'other' })]);
    assert.equal(listed.length, 2);
    assert.equal(Array.isArray(listed), true);
  });
});

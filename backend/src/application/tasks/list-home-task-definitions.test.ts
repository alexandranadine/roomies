import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHomeLocalDate } from '../../domains/tasks/home-local-date.js';
import type { TaskDefinition } from '../../domains/tasks/task-definition.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { listHomeTaskDefinitions } from './list-home-task-definitions.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CREATED = new Date('2026-09-12T18:00:00.000Z');

function actor(overrides: Partial<ActiveHomeActor> = {}): ActiveHomeActor {
  return {
    userId: USER,
    membershipId: MEMBERSHIP,
    homeId: HOME,
    role: 'ROOMMATE',
    ...overrides,
  };
}

function definition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    homeId: HOME,
    title: 'Weekly trash',
    frequency: 'WEEKLY',
    weekday: 1,
    dayOfMonth: null,
    assignedMembershipId: null,
    creatorMembershipId: MEMBERSHIP,
    nextOccurrenceDate: parseHomeLocalDate('2026-09-14'),
    nextOccurrenceAt: new Date('2026-09-14T00:00:00.000Z'),
    deactivatedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

void describe('listHomeTaskDefinitions', () => {
  void it('returns Home-scoped definitions for an authorized actor', async () => {
    const listed = [definition()];
    const homes: string[] = [];
    const result = await listHomeTaskDefinitions(
      { actor: actor(), homeId: HOME },
      {
        listDefinitionsByHome(homeId) {
          homes.push(homeId);
          return Promise.resolve(listed);
        },
      },
    );
    assert.deepEqual(result, listed);
    assert.deepEqual(homes, [HOME]);
  });

  void it('conceals a Home-scope mismatch without listing', async () => {
    const homes: string[] = [];
    await assert.rejects(
      () =>
        listHomeTaskDefinitions(
          { actor: actor(), homeId: OTHER_HOME },
          {
            listDefinitionsByHome(homeId) {
              homes.push(homeId);
              return Promise.resolve([]);
            },
          },
        ),
      ConcealedNotFoundError,
    );
    assert.deepEqual(homes, []);
  });
});

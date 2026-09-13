import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TaskInstance } from '../../domains/tasks/task.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import { ConcealedNotFoundError } from '../../platform/authz/errors.js';
import { listHomeTasks } from './list-home-tasks.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CREATED = new Date('2026-09-12T18:00:00.000Z');

const actor: ActiveHomeActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  homeId: HOME,
  role: 'ROOMMATE',
};

function task(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    id: '018f1e2c-7e3a-7000-8000-1234567890ab',
    homeId: HOME,
    source: 'MANUAL',
    status: 'OPEN',
    title: 'Take out trash',
    scheduledFor: null,
    assignedMembershipId: null,
    completedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

void describe('listHomeTasks', () => {
  void it('returns the authorized Home snapshot list including an empty Home', async () => {
    const empty = await listHomeTasks(
      { actor, homeId: HOME },
      { listByHome: () => Promise.resolve([]) },
    );
    assert.deepEqual(empty, []);

    const rows = [task(), task({ id: 'other', source: 'RECURRING' })];
    const listed = await listHomeTasks(
      { actor, homeId: HOME },
      { listByHome: (homeId) => Promise.resolve(homeId === HOME ? rows : []) },
    );
    assert.equal(listed.length, 2);
    assert.equal(listed[1]?.source, 'RECURRING');
  });

  void it('lets an active Admin list through the same task.list path', async () => {
    const listed = await listHomeTasks(
      { actor: { ...actor, role: 'ADMIN' }, homeId: HOME },
      { listByHome: () => Promise.resolve([task()]) },
    );
    assert.equal(listed.length, 1);
  });

  void it('conceals a Home-scope mismatch without reading Tasks', async () => {
    await assert.rejects(
      () =>
        listHomeTasks(
          { actor, homeId: OTHER_HOME },
          {
            listByHome: () =>
              Promise.reject(new Error('must not list on policy deny')),
          },
        ),
      ConcealedNotFoundError,
    );
  });
});

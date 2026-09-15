import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TransactionContext } from '../../platform/persistence/transaction.js';
import { createDeleteActivitiesForSource } from './delete-activities-for-source.js';

const TX = {} as TransactionContext;
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

void describe('createDeleteActivitiesForSource', () => {
  void it('deletes recipients then activities for the exact Maintenance source', async () => {
    const calls: string[] = [];
    const deleteActivities = createDeleteActivitiesForSource(
      {
        deleteRecipientsBySource(_tx, input) {
          calls.push(`recipients:${input.homeId}:${input.sourceEntityId}`);
          assert.equal(input.sourceEntityType, 'MAINTENANCE');
          return Promise.resolve();
        },
        deleteActivitiesBySource(_tx, input) {
          calls.push(`activities:${input.homeId}:${input.sourceEntityId}`);
          assert.equal(input.sourceEntityType, 'MAINTENANCE');
          return Promise.resolve();
        },
      },
      {
        afterRecipientsDeleted() {
          calls.push('after-recipients');
          return Promise.resolve();
        },
        afterActivitiesDeleted() {
          calls.push('after-activities');
          return Promise.resolve();
        },
      },
    );

    await deleteActivities(TX, {
      homeId: HOME,
      sourceEntityType: 'MAINTENANCE',
      sourceEntityId: SOURCE,
    });

    assert.deepEqual(calls, [
      `recipients:${HOME}:${SOURCE}`,
      'after-recipients',
      `activities:${HOME}:${SOURCE}`,
      'after-activities',
    ]);
  });

  void it('stops after recipient deletion when the hook fails', async () => {
    const calls: string[] = [];
    const deleteActivities = createDeleteActivitiesForSource(
      {
        deleteRecipientsBySource() {
          calls.push('recipients');
          return Promise.resolve();
        },
        deleteActivitiesBySource() {
          calls.push('activities');
          return Promise.resolve();
        },
      },
      {
        afterRecipientsDeleted() {
          return Promise.reject(new Error('injected after recipients'));
        },
      },
    );

    await assert.rejects(
      () =>
        deleteActivities(TX, {
          homeId: HOME,
          sourceEntityType: 'MAINTENANCE',
          sourceEntityId: SOURCE,
        }),
      /injected after recipients/,
    );
    assert.deepEqual(calls, ['recipients']);
  });
});

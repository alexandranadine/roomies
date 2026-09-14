import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TASK_COMPLETED_V1, createTaskCompletedV1Event } from './events.js';

const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ef';
const TASK_ID = '018f1e2c-7e3a-7000-8000-1234567890cd';
const OCCURRED_AT = new Date('2026-09-13T18:00:00.000Z');

void describe('task domain event contracts', () => {
  void it('builds task.completed.v1 with only taskInstanceId in payload', () => {
    const event = createTaskCompletedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      homeId: HOME_ID,
      taskInstanceId: TASK_ID,
    });

    assert.equal(event.eventType, TASK_COMPLETED_V1);
    assert.deepEqual(Object.keys(event.payload), ['taskInstanceId']);
    assert.deepEqual(event.payload, { taskInstanceId: TASK_ID });
    assert.equal(event.homeId, HOME_ID);
    assert.equal(event.occurredAt, OCCURRED_AT);
    assert.equal('title' in event.payload, false);
    assert.equal('assignedMembershipId' in event.payload, false);
    assert.equal('completedByMembershipId' in event.payload, false);
    assert.equal('actorMembershipId' in event.payload, false);
    assert.equal('userId' in event.payload, false);
    assert.equal('name' in event.payload, false);
    assert.equal('actorId' in event, false);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HOME_ARCHIVED_V1, createHomeArchivedV1Event } from './events.js';

const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ef';
const OCCURRED_AT = new Date('2026-03-15T12:34:56.789Z');

void describe('homes domain event contracts', () => {
  void it('builds home.archived.v1 with only homeId in the payload', () => {
    const event = createHomeArchivedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      homeId: HOME_ID,
    });

    assert.equal(event.eventType, HOME_ARCHIVED_V1);
    assert.deepEqual(Object.keys(event.payload), ['homeId']);
    assert.deepEqual(event.payload, { homeId: HOME_ID });
    assert.equal(event.homeId, HOME_ID);
    assert.equal('name' in event.payload, false);
    assert.equal('email' in event.payload, false);
    assert.equal('actorId' in event, false);
  });
});

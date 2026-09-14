import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SUPPLY_OBTAINED_V1, createSupplyObtainedV1Event } from './events.js';

const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ef';
const ENTRY_ID = '018f1e2c-7e3a-7000-8000-1234567890cd';
const OCCURRED_AT = new Date('2026-09-13T18:00:00.000Z');

void describe('supply domain event contracts', () => {
  void it('builds supply.obtained.v1 with only supplyEntryId in payload', () => {
    const event = createSupplyObtainedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      homeId: HOME_ID,
      supplyEntryId: ENTRY_ID,
    });

    assert.equal(event.eventType, SUPPLY_OBTAINED_V1);
    assert.deepEqual(Object.keys(event.payload), ['supplyEntryId']);
    assert.deepEqual(event.payload, { supplyEntryId: ENTRY_ID });
    assert.equal(event.homeId, HOME_ID);
    assert.equal(event.occurredAt, OCCURRED_AT);
    assert.equal('title' in event.payload, false);
    assert.equal('createdByMembershipId' in event.payload, false);
    assert.equal('obtainedByMembershipId' in event.payload, false);
    assert.equal('claimantMembershipId' in event.payload, false);
    assert.equal('actorMembershipId' in event.payload, false);
    assert.equal('userId' in event.payload, false);
    assert.equal('name' in event.payload, false);
    assert.equal('actorId' in event, false);
  });
});

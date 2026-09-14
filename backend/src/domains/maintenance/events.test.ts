import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAINTENANCE_CREATED_V1,
  MAINTENANCE_RESOLVED_V1,
  createMaintenanceCreatedV1Event,
  createMaintenanceResolvedV1Event,
} from './events.js';

const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ef';
const ENTRY_ID = '018f1e2c-7e3a-7000-8000-1234567890cd';
const OCCURRED_AT = new Date('2026-09-13T18:00:00.000Z');

void describe('maintenance domain event contracts', () => {
  void it('builds maintenance.created.v1 with only maintenanceEntryId in payload', () => {
    const event = createMaintenanceCreatedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      homeId: HOME_ID,
      maintenanceEntryId: ENTRY_ID,
    });

    assert.equal(event.eventType, MAINTENANCE_CREATED_V1);
    assert.deepEqual(Object.keys(event.payload), ['maintenanceEntryId']);
    assert.deepEqual(event.payload, { maintenanceEntryId: ENTRY_ID });
    assert.equal(event.homeId, HOME_ID);
    assert.equal('title' in event.payload, false);
    assert.equal('details' in event.payload, false);
    assert.equal('visibility' in event.payload, false);
    assert.equal('audienceMembershipIds' in event.payload, false);
    assert.equal('userId' in event.payload, false);
    assert.equal('actorId' in event, false);
  });

  void it('builds maintenance.resolved.v1 with only maintenanceEntryId in payload', () => {
    const event = createMaintenanceResolvedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      homeId: HOME_ID,
      maintenanceEntryId: ENTRY_ID,
    });

    assert.equal(event.eventType, MAINTENANCE_RESOLVED_V1);
    assert.deepEqual(Object.keys(event.payload), ['maintenanceEntryId']);
    assert.deepEqual(event.payload, { maintenanceEntryId: ENTRY_ID });
    assert.equal(event.homeId, HOME_ID);
    assert.equal('title' in event.payload, false);
    assert.equal('details' in event.payload, false);
    assert.equal('resolvedByMembershipId' in event.payload, false);
    assert.equal('userId' in event.payload, false);
  });
});

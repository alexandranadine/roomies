import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MEMBERSHIP_ENDED_CAUSES,
  MEMBERSHIP_ENDED_V1,
  MEMBERSHIP_ROLE_CHANGED_V1,
  createMembershipEndedV1Event,
  createMembershipRoleChangedV1Event,
} from './events.js';

const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890cd';
const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ef';
const OCCURRED_AT = new Date('2026-03-15T12:34:56.789Z');

const PRIVATE_PAYLOAD_KEYS = [
  'name',
  'nickname',
  'email',
  'userId',
  'actorId',
  'session',
  'reason',
  'metadata',
] as const;

void describe('memberships domain event contracts', () => {
  void it('builds membership.ended.v1 with only membershipId and bounded cause', () => {
    const event = createMembershipEndedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      membershipId: MEMBERSHIP_ID,
      cause: 'VOLUNTARY_LEAVE',
      homeId: HOME_ID,
    });

    assert.equal(event.eventType, MEMBERSHIP_ENDED_V1);
    assert.equal(event.eventId, EVENT_ID);
    assert.equal(event.occurredAt, OCCURRED_AT);
    assert.equal(event.homeId, HOME_ID);
    assert.deepEqual(Object.keys(event.payload), ['membershipId', 'cause']);
    assert.deepEqual(event.payload, {
      membershipId: MEMBERSHIP_ID,
      cause: 'VOLUNTARY_LEAVE',
    });
    assert.equal('actorId' in event, false);
    assert.equal('initiatingMembershipId' in event, false);
    for (const key of PRIVATE_PAYLOAD_KEYS) {
      assert.equal(key in event.payload, false);
    }
  });

  void it('constructs membership.ended.v1 for each frozen structural cause', () => {
    assert.deepEqual(
      [...MEMBERSHIP_ENDED_CAUSES],
      ['VOLUNTARY_LEAVE', 'ADMIN_REMOVAL', 'HOME_ARCHIVED'],
    );

    for (const cause of MEMBERSHIP_ENDED_CAUSES) {
      const event = createMembershipEndedV1Event({
        eventId: EVENT_ID,
        occurredAt: OCCURRED_AT,
        membershipId: MEMBERSHIP_ID,
        cause,
      });
      assert.equal(event.payload.cause, cause);
      assert.deepEqual(Object.keys(event.payload), ['membershipId', 'cause']);
    }
  });

  void it('rejects an arbitrary cause through the typed factory', () => {
    assert.throws(
      () =>
        createMembershipEndedV1Event({
          eventId: EVENT_ID,
          occurredAt: OCCURRED_AT,
          membershipId: MEMBERSHIP_ID,
          cause: 'because they left' as 'VOLUNTARY_LEAVE',
        }),
      /Invalid membership ended cause/,
    );
  });

  void it('builds membership.role_changed.v1 for ROOMMATE to ADMIN', () => {
    const event = createMembershipRoleChangedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      membershipId: MEMBERSHIP_ID,
      previousRole: 'ROOMMATE',
      newRole: 'ADMIN',
      homeId: HOME_ID,
    });

    assert.equal(event.eventType, MEMBERSHIP_ROLE_CHANGED_V1);
    assert.equal(event.eventId, EVENT_ID);
    assert.equal(event.occurredAt, OCCURRED_AT);
    assert.equal(event.homeId, HOME_ID);
    assert.deepEqual(Object.keys(event.payload), [
      'membershipId',
      'previousRole',
      'newRole',
    ]);
    assert.deepEqual(event.payload, {
      membershipId: MEMBERSHIP_ID,
      previousRole: 'ROOMMATE',
      newRole: 'ADMIN',
    });
    for (const key of PRIVATE_PAYLOAD_KEYS) {
      assert.equal(key in event.payload, false);
    }
  });

  void it('builds membership.role_changed.v1 for ADMIN to ROOMMATE', () => {
    const event = createMembershipRoleChangedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      membershipId: MEMBERSHIP_ID,
      previousRole: 'ADMIN',
      newRole: 'ROOMMATE',
    });

    assert.equal(event.eventType, MEMBERSHIP_ROLE_CHANGED_V1);
    assert.equal(event.homeId, undefined);
    assert.deepEqual(Object.keys(event.payload), [
      'membershipId',
      'previousRole',
      'newRole',
    ]);
    assert.deepEqual(event.payload, {
      membershipId: MEMBERSHIP_ID,
      previousRole: 'ADMIN',
      newRole: 'ROOMMATE',
    });
  });

  void it('rejects an arbitrary role through the typed factory', () => {
    assert.throws(
      () =>
        createMembershipRoleChangedV1Event({
          eventId: EVENT_ID,
          occurredAt: OCCURRED_AT,
          membershipId: MEMBERSHIP_ID,
          previousRole: 'OWNER' as 'ROOMMATE',
          newRole: 'ADMIN',
        }),
      /Invalid membership role/,
    );
  });
});

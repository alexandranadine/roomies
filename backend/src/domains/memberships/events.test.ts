import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MEMBERSHIP_ENDED_CAUSES,
  MEMBERSHIP_ENDED_V1,
  MEMBERSHIP_ROLE_CHANGED_V1,
  MEMBERSHIP_STARTED_V1,
  createMembershipEndedV1Event,
  createMembershipRoleChangedV1Event,
  createMembershipStartedV1Event,
} from './events.js';

const EVENT_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const MEMBERSHIP_ID = '018f1e2c-7e3a-7000-8000-1234567890cd';
const HOME_ID = '018f1e2c-7e3a-7000-8000-1234567890ef';
const TRANSITION_ID = '018f1e2c-7e3a-7000-8000-1234567890aa';
const OCCURRED_AT = new Date('2026-03-15T12:34:56.789Z');

const PRIVATE_PAYLOAD_KEYS = [
  'name',
  'nickname',
  'email',
  'userId',
  'actorId',
  'actorMembershipId',
  'session',
  'reason',
  'metadata',
  'cause',
  'invitationId',
  'previousRole',
  'newRole',
  'role',
] as const;

void describe('memberships domain event contracts', () => {
  void it('builds membership.started.v1 with only membershipId', () => {
    const event = createMembershipStartedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      homeId: HOME_ID,
      membershipId: MEMBERSHIP_ID,
    });

    assert.equal(event.eventType, MEMBERSHIP_STARTED_V1);
    assert.equal(event.eventId, EVENT_ID);
    assert.equal(event.occurredAt, OCCURRED_AT);
    assert.equal(event.homeId, HOME_ID);
    assert.deepEqual(Object.keys(event.payload), ['membershipId']);
    assert.deepEqual(event.payload, {
      membershipId: MEMBERSHIP_ID,
    });
    assert.equal('actorId' in event, false);
    assert.equal('actorMembershipId' in event.payload, false);
    for (const key of PRIVATE_PAYLOAD_KEYS) {
      assert.equal(key in event.payload, false);
    }
  });

  void it('builds membership.ended.v1 with only membershipId', () => {
    const event = createMembershipEndedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      membershipId: MEMBERSHIP_ID,
      homeId: HOME_ID,
    });

    assert.equal(event.eventType, MEMBERSHIP_ENDED_V1);
    assert.equal(event.eventId, EVENT_ID);
    assert.equal(event.occurredAt, OCCURRED_AT);
    assert.equal(event.homeId, HOME_ID);
    assert.deepEqual(Object.keys(event.payload), ['membershipId']);
    assert.deepEqual(event.payload, {
      membershipId: MEMBERSHIP_ID,
    });
    assert.equal('actorId' in event, false);
    assert.equal('initiatingMembershipId' in event, false);
    for (const key of PRIVATE_PAYLOAD_KEYS) {
      assert.equal(key in event.payload, false);
    }
  });

  void it('keeps ended causes as application input only, not event payload', () => {
    assert.deepEqual(
      [...MEMBERSHIP_ENDED_CAUSES],
      ['VOLUNTARY_LEAVE', 'ADMIN_REMOVAL', 'HOME_ARCHIVED'],
    );
  });

  void it('builds membership.role_changed.v1 with membershipId and roleTransitionId', () => {
    const event = createMembershipRoleChangedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      membershipId: MEMBERSHIP_ID,
      roleTransitionId: TRANSITION_ID,
      homeId: HOME_ID,
    });

    assert.equal(event.eventType, MEMBERSHIP_ROLE_CHANGED_V1);
    assert.equal(event.eventId, EVENT_ID);
    assert.equal(event.occurredAt, OCCURRED_AT);
    assert.equal(event.homeId, HOME_ID);
    assert.deepEqual(Object.keys(event.payload), [
      'membershipId',
      'roleTransitionId',
    ]);
    assert.deepEqual(event.payload, {
      membershipId: MEMBERSHIP_ID,
      roleTransitionId: TRANSITION_ID,
    });
    for (const key of PRIVATE_PAYLOAD_KEYS) {
      assert.equal(key in event.payload, false);
    }
  });

  void it('allows role_changed without a homeId envelope field', () => {
    const event = createMembershipRoleChangedV1Event({
      eventId: EVENT_ID,
      occurredAt: OCCURRED_AT,
      membershipId: MEMBERSHIP_ID,
      roleTransitionId: TRANSITION_ID,
    });

    assert.equal(event.eventType, MEMBERSHIP_ROLE_CHANGED_V1);
    assert.equal(event.homeId, undefined);
    assert.deepEqual(Object.keys(event.payload), [
      'membershipId',
      'roleTransitionId',
    ]);
  });
});

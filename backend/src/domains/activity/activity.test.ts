import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isActivitySourceEntityType,
  isActivityVisibilityClass,
  isValidActivityEventType,
  ACTIVITY_SOURCE_ENTITY_TYPES,
  ACTIVITY_VISIBILITY_CLASSES,
  MAX_ACTIVITY_EVENT_TYPE_LENGTH,
} from './activity.js';

void describe('Activity domain values', () => {
  void it('freezes the October source-entity and visibility enumerations', () => {
    assert.deepEqual(ACTIVITY_SOURCE_ENTITY_TYPES, [
      'MEMBERSHIP',
      'TASK',
      'SUPPLY',
      'MAINTENANCE',
    ]);
    assert.deepEqual(ACTIVITY_VISIBILITY_CLASSES, [
      'HOME_VISIBLE',
      'SOURCE_AUTHORIZED',
    ]);
    assert.equal(MAX_ACTIVITY_EVENT_TYPE_LENGTH, 200);
    assert.equal(isActivitySourceEntityType('TASK'), true);
    assert.equal(isActivitySourceEntityType('TASK_INSTANCE'), false);
    assert.equal(isActivitySourceEntityType('INVITATION'), false);
    assert.equal(isActivityVisibilityClass('HOME_VISIBLE'), true);
    assert.equal(isActivityVisibilityClass('SOURCE_AUTHORIZED'), true);
    assert.equal(isActivityVisibilityClass('PUBLIC'), false);
    assert.equal(isActivityVisibilityClass('PRIVATE'), false);
    assert.equal(isActivityVisibilityClass('HOUSEHOLD'), false);
  });

  void it('accepts nonempty bounded eventType strings without a version column', () => {
    assert.equal(isValidActivityEventType('maintenance.created.v1'), true);
    assert.equal(isValidActivityEventType('a'.repeat(200)), true);
    assert.equal(isValidActivityEventType(''), false);
    assert.equal(isValidActivityEventType('a'.repeat(201)), false);
    assert.equal(isValidActivityEventType(null), false);
  });
});

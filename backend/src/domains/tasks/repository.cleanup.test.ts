import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
  UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
} from './repository.js';

void describe('Task membership-ending cleanup SQL', () => {
  void it('unassigns only OPEN TaskInstances for the exact Home and Membership', () => {
    assert.match(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /UPDATE task_instances/,
    );
    assert.match(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /assigned_membership_id = NULL/,
    );
    assert.match(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /updated_at = \$3::timestamptz/,
    );
    assert.match(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /home_id = \$1::uuid/,
    );
    assert.match(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /assigned_membership_id = \$2::uuid/,
    );
    assert.match(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /status = 'OPEN'/,
    );
    assert.doesNotMatch(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /user_id/,
    );
    assert.doesNotMatch(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /DELETE /i,
    );
    assert.doesNotMatch(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /status = 'COMPLETED'/,
    );
    assert.doesNotMatch(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /title/,
    );
    assert.doesNotMatch(
      UNASSIGN_OPEN_TASK_INSTANCES_FOR_MEMBERSHIP_SQL,
      /task_definition_id/,
    );
  });

  void it('unassigns only active TaskDefinitions and never writes creator', () => {
    assert.match(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /UPDATE task_definitions/,
    );
    assert.match(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /assigned_membership_id = NULL/,
    );
    assert.match(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /updated_at = \$3::timestamptz/,
    );
    assert.match(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /home_id = \$1::uuid/,
    );
    assert.match(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /assigned_membership_id = \$2::uuid/,
    );
    assert.match(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /deactivated_at IS NULL/,
    );
    assert.doesNotMatch(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /creator_membership_id/,
    );
    assert.doesNotMatch(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /user_id/,
    );
    assert.doesNotMatch(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /DELETE /i,
    );
    assert.doesNotMatch(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /next_occurrence_at/,
    );
    assert.doesNotMatch(
      UNASSIGN_ACTIVE_TASK_DEFINITIONS_FOR_MEMBERSHIP_SQL,
      /recurrence_/,
    );
  });
});

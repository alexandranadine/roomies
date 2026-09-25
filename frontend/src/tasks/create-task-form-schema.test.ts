import { describe, expect, it } from 'vitest';
import {
  createTaskFormSchema,
  toCreateTaskRequest,
  type CreateTaskFormValues,
} from './create-task-form-schema.js';
import { TEST_MEMBERSHIP_B } from './test-fixtures.js';

function values(
  overrides: Partial<CreateTaskFormValues> = {},
): CreateTaskFormValues {
  return {
    title: 'Take out trash',
    assignedMembershipId: '',
    scheduledFor: '',
    repeat: 'ONCE',
    weekday: 1,
    dayOfMonth: 1,
    ...overrides,
  };
}

describe('create task form schema', () => {
  it('rejects a blank title', () => {
    const result = createTaskFormSchema.safeParse(values({ title: '   ' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Enter a title.');
    }
  });

  it('maps one-time create to TaskInstance fields', () => {
    expect(
      toCreateTaskRequest(
        values({
          assignedMembershipId: TEST_MEMBERSHIP_B,
          scheduledFor: '2026-09-25',
        }),
      ),
    ).toEqual({
      kind: 'task',
      body: {
        title: 'Take out trash',
        assignedMembershipId: TEST_MEMBERSHIP_B,
        scheduledFor: '2026-09-25',
      },
    });
  });

  it('omits empty assignment and due date as null', () => {
    expect(toCreateTaskRequest(values())).toEqual({
      kind: 'task',
      body: {
        title: 'Take out trash',
        assignedMembershipId: null,
        scheduledFor: null,
      },
    });
  });

  it('maps daily/weekly/monthly to TaskDefinition fields', () => {
    expect(toCreateTaskRequest(values({ repeat: 'DAILY' }))).toEqual({
      kind: 'definition',
      body: {
        title: 'Take out trash',
        frequency: 'DAILY',
        assignedMembershipId: null,
      },
    });
    expect(
      toCreateTaskRequest(values({ repeat: 'WEEKLY', weekday: 3 })),
    ).toEqual({
      kind: 'definition',
      body: {
        title: 'Take out trash',
        frequency: 'WEEKLY',
        weekday: 3,
        assignedMembershipId: null,
      },
    });
    expect(
      toCreateTaskRequest(values({ repeat: 'MONTHLY', dayOfMonth: 15 })),
    ).toEqual({
      kind: 'definition',
      body: {
        title: 'Take out trash',
        frequency: 'MONTHLY',
        dayOfMonth: 15,
        assignedMembershipId: null,
      },
    });
  });
});

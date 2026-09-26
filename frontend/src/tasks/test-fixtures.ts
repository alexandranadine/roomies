import type { ActiveHomeMemberships } from '../homes/home-memberships-api.js';
import type { Task, TaskDefinition } from './tasks-api.js';

export const TEST_HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEST_HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
export const TEST_MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';
export const TEST_ENDED_MEMBERSHIP = 'm9999999-9999-4999-8999-999999999999';
export const TEST_REJOIN_MEMBERSHIP = 'm8888888-8888-4888-8888-888888888888';

const BASE_TIMES = {
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-10T15:30:00.000Z',
} as const;

export const FIXTURE_OPEN_ASSIGNED: Task = {
  id: 't1111111-1111-4111-8111-111111111111',
  title: 'Take out trash',
  status: 'OPEN',
  source: 'MANUAL',
  scheduledFor: '2026-09-25',
  assignedMembershipId: TEST_MEMBERSHIP_B,
  ...BASE_TIMES,
};

export const FIXTURE_OPEN_UNASSIGNED: Task = {
  id: 't2222222-2222-4222-8222-222222222222',
  title: 'Wipe counters',
  status: 'OPEN',
  source: 'MANUAL',
  scheduledFor: null,
  assignedMembershipId: null,
  ...BASE_TIMES,
};

export const FIXTURE_OPEN_YOURS: Task = {
  id: 't3333333-3333-4333-8333-333333333333',
  title: 'Run dishwasher',
  status: 'OPEN',
  source: 'MANUAL',
  scheduledFor: null,
  assignedMembershipId: TEST_MEMBERSHIP_A,
  ...BASE_TIMES,
};

export const FIXTURE_OPEN_OVERDUE: Task = {
  id: 't7777777-7777-4777-8777-777777777777',
  title: 'Pay water bill',
  status: 'OPEN',
  source: 'MANUAL',
  scheduledFor: '2020-01-15',
  assignedMembershipId: TEST_MEMBERSHIP_B,
  ...BASE_TIMES,
};

export const FIXTURE_COMPLETED: Task = {
  id: 't4444444-4444-4444-8444-444444444444',
  title: 'Sweep hallway',
  status: 'COMPLETED',
  source: 'MANUAL',
  scheduledFor: '2026-09-10',
  assignedMembershipId: TEST_ENDED_MEMBERSHIP,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-10T18:00:00.000Z',
};

export const FIXTURE_RECURRING_INSTANCE: Task = {
  id: 't5555555-5555-4555-8555-555555555555',
  title: 'Weekly trash',
  status: 'OPEN',
  source: 'RECURRING',
  scheduledFor: '2026-09-28',
  assignedMembershipId: TEST_MEMBERSHIP_A,
  ...BASE_TIMES,
};

export const FIXTURE_HOME_B_TASK: Task = {
  id: 't6666666-6666-4666-8666-666666666666',
  title: 'Water the plants',
  status: 'OPEN',
  source: 'MANUAL',
  scheduledFor: null,
  assignedMembershipId: TEST_MEMBERSHIP_B,
  ...BASE_TIMES,
};

export const FIXTURE_DEFINITION_WEEKLY: TaskDefinition = {
  id: 'd1111111-1111-4111-8111-111111111111',
  title: 'Weekly trash',
  frequency: 'WEEKLY',
  weekday: 1,
  dayOfMonth: null,
  assignedMembershipId: TEST_MEMBERSHIP_A,
  creatorMembershipId: TEST_MEMBERSHIP_A,
  nextOccurrenceDate: '2026-09-28',
  deactivatedAt: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
};

export const FIXTURE_DEFINITION_OTHER: TaskDefinition = {
  id: 'd2222222-2222-4222-8222-222222222222',
  title: 'Bathroom tidy',
  frequency: 'DAILY',
  weekday: null,
  dayOfMonth: null,
  assignedMembershipId: TEST_MEMBERSHIP_B,
  creatorMembershipId: TEST_MEMBERSHIP_B,
  nextOccurrenceDate: '2026-09-25',
  deactivatedAt: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
};

export const FIXTURE_DEFINITION_MONTHLY: TaskDefinition = {
  id: 'd4444444-4444-4444-8444-444444444444',
  title: 'Clean kitchen',
  frequency: 'MONTHLY',
  weekday: null,
  dayOfMonth: 1,
  assignedMembershipId: null,
  creatorMembershipId: TEST_MEMBERSHIP_A,
  nextOccurrenceDate: '2026-10-01',
  deactivatedAt: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
};

export const FIXTURE_DEFINITION_DAILY: TaskDefinition = {
  id: 'd5555555-5555-4555-8555-555555555555',
  title: 'Wipe stove',
  frequency: 'DAILY',
  weekday: null,
  dayOfMonth: null,
  assignedMembershipId: TEST_MEMBERSHIP_B,
  creatorMembershipId: TEST_MEMBERSHIP_A,
  nextOccurrenceDate: '2026-09-25',
  deactivatedAt: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:00.000Z',
};

export const FIXTURE_DEFINITION_DEACTIVATED: TaskDefinition = {
  id: 'd3333333-3333-4333-8333-333333333333',
  title: 'Old repeating task',
  frequency: 'MONTHLY',
  weekday: null,
  dayOfMonth: 1,
  assignedMembershipId: null,
  creatorMembershipId: TEST_MEMBERSHIP_A,
  nextOccurrenceDate: null,
  deactivatedAt: '2026-09-12T12:00:00.000Z',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-12T12:00:00.000Z',
};

export function defaultMemberships(
  homeId: string = TEST_HOME_A,
): ActiveHomeMemberships {
  if (homeId === TEST_HOME_B) {
    return {
      currentMembershipId: TEST_MEMBERSHIP_B,
      memberships: [
        { membershipId: TEST_MEMBERSHIP_B, name: 'Casey' },
        { membershipId: 'm3333333-3333-4333-8333-333333333333', name: 'Drew' },
      ],
    };
  }
  return {
    currentMembershipId: TEST_MEMBERSHIP_A,
    memberships: [
      { membershipId: TEST_MEMBERSHIP_A, name: 'Alex' },
      { membershipId: TEST_MEMBERSHIP_B, name: 'Jamie' },
    ],
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function notFoundBody() {
  return { error: { code: 'NOT_FOUND', message: 'Not found' } };
}

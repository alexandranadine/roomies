import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Activity } from '../../domains/activity/activity.js';
import { ACTIVITY_LIST_DEFAULT_LIMIT } from '../../domains/activity/cursor.js';
import { InvalidActivityRequestError } from '../../domains/activity/errors.js';
import type {
  ActivityListPage,
  ActivityRepositoryPage,
} from '../../domains/activity/activity-list-item.js';
import type { ListVisibleActivityPage } from '../../domains/activity/repository.js';
import type { HistoricalMembershipDisplay } from '../../domains/memberships/find-historical-membership-display.js';
import type { ActiveHomeActor } from '../../platform/authz/context.js';
import {
  ConcealedNotFoundError,
  InvalidRequestError,
} from '../../platform/authz/errors.js';
import { listHomeActivity } from './list-home-activity.js';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_HOME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALEX = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TAYLOR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TASK = '018f1e2c-7e3a-7000-8000-1234567890ab';
const SUPPLY = '018f1e2c-7e3a-7000-8000-1234567890ac';
const HOUSEHOLD = '018f1e2c-7e3a-7000-8000-1234567890ad';
const PRIVATE_MAINT = '018f1e2c-7e3a-7000-8000-1234567890ae';
const MISSING_TASK = '018f1e2c-7e3a-7000-8000-1234567890b2';
const OCCURRED = new Date('2026-09-13T18:00:00.000Z');

const actor: ActiveHomeActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  membershipId: ALEX,
  homeId: HOME,
  role: 'ROOMMATE',
};

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: TASK,
    homeId: HOME,
    sourceOutboxEventId: '018f1e2c-7e3a-7000-8000-1234567890c0',
    sourceEntityType: 'TASK',
    sourceEntityId: TASK,
    eventType: 'task.completed.v1',
    visibilityClass: 'HOME_VISIBLE',
    actorMembershipId: ALEX,
    occurredAt: OCCURRED,
    createdAt: OCCURRED,
    ...overrides,
  };
}

function page(
  overrides: Partial<ActivityRepositoryPage> = {},
): ActivityRepositoryPage {
  return {
    items: [activity()],
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

function memberships(
  entries: readonly HistoricalMembershipDisplay[],
): ReadonlyMap<string, HistoricalMembershipDisplay> {
  return new Map(entries.map((entry) => [entry.membershipId, entry]));
}

function unusedList(): never {
  throw new Error('must not list Activity on policy deny');
}

function deps(
  options: {
    page?: ActivityRepositoryPage | null;
    list?: (
      input: ListVisibleActivityPage,
    ) => Promise<ActivityRepositoryPage | null>;
    memberships?: ReadonlyMap<string, HistoricalMembershipDisplay>;
    tasks?: ReadonlyMap<string, { id: string; title: string }>;
    supplies?: ReadonlyMap<string, { id: string; title: string }>;
    maintenance?: ReadonlyMap<
      string,
      { id: string; visibility: 'HOUSEHOLD' | 'PRIVATE'; title: string | null }
    >;
  } = {},
) {
  return {
    activity: {
      listVisiblePageByHome:
        options.list ??
        (() =>
          Promise.resolve(options.page === undefined ? page() : options.page)),
    },
    findHistoricalMembershipDisplays: () =>
      Promise.resolve(
        options.memberships ??
          memberships([{ membershipId: ALEX, name: 'Alex' }]),
      ),
    findTaskActivityDisplays: () =>
      Promise.resolve(
        options.tasks ?? new Map([[TASK, { id: TASK, title: 'Trash' }]]),
      ),
    findSupplyActivityDisplays: () =>
      Promise.resolve(
        options.supplies ?? new Map([[SUPPLY, { id: SUPPLY, title: 'Milk' }]]),
      ),
    findMaintenanceActivityDisplays: () =>
      Promise.resolve(
        options.maintenance ??
          new Map([
            [
              HOUSEHOLD,
              {
                id: HOUSEHOLD,
                visibility: 'HOUSEHOLD' as const,
                title: 'Leak',
              },
            ],
            [
              PRIVATE_MAINT,
              {
                id: PRIVATE_MAINT,
                visibility: 'PRIVATE' as const,
                title: null,
              },
            ],
          ]),
      ),
  };
}

void describe('listHomeActivity', () => {
  void it('returns the repository page without filtering or sorting', async () => {
    const repositoryPage = page({
      items: [
        activity({
          id: 'newer',
          occurredAt: new Date('2026-09-13T19:00:00.000Z'),
        }),
        activity({
          id: 'older',
          occurredAt: new Date('2026-09-13T17:00:00.000Z'),
        }),
      ],
      hasMore: true,
      nextCursor: 'opaque-cursor',
    });
    const listed = await listHomeActivity(
      { actor, homeId: HOME },
      deps({
        page: repositoryPage,
      }),
    );
    assert.deepEqual(
      listed.items.map((row) => row.id),
      ['newer', 'older'],
    );
    assert.equal(listed.hasMore, true);
    assert.equal(listed.nextCursor, 'opaque-cursor');
  });

  void it('preserves a valid empty page from the repository', async () => {
    const empty = page({ items: [], hasMore: false, nextCursor: null });
    const listed = await listHomeActivity(
      { actor, homeId: HOME },
      deps({ page: empty }),
    );
    assert.deepEqual(listed, {
      items: [],
      hasMore: false,
      nextCursor: null,
    } satisfies ActivityListPage);
  });

  void it('conceals a stale-scope repository null without converting it to empty', async () => {
    await assert.rejects(
      () => listHomeActivity({ actor, homeId: HOME }, deps({ page: null })),
      ConcealedNotFoundError,
    );
  });

  void it('passes actor Membership identity, default limit, and optional cursor', async () => {
    const calls: ListVisibleActivityPage[] = [];
    await listHomeActivity(
      { actor, homeId: HOME },
      deps({
        list: (input) => {
          calls.push(input);
          return Promise.resolve(page({ items: [] }));
        },
      }),
    );
    await listHomeActivity(
      {
        actor: { ...actor, role: 'ADMIN' },
        homeId: HOME,
        limit: 10,
        cursor: 'next-page',
      },
      deps({
        list: (input) => {
          calls.push(input);
          return Promise.resolve(page({ items: [] }));
        },
      }),
    );
    assert.deepEqual(calls, [
      {
        homeId: HOME,
        actorMembershipId: ALEX,
        limit: ACTIVITY_LIST_DEFAULT_LIMIT,
      },
      {
        homeId: HOME,
        actorMembershipId: ALEX,
        limit: 10,
        cursor: 'next-page',
      },
    ]);
    assert.equal('userId' in calls[0]!, false);
  });

  void it('maps invalid limit and cursor failures to InvalidRequestError', async () => {
    await assert.rejects(
      () =>
        listHomeActivity(
          { actor, homeId: HOME, limit: 0 },
          deps({
            list: () => Promise.reject(new InvalidActivityRequestError()),
          }),
        ),
      InvalidRequestError,
    );
    await assert.rejects(
      () =>
        listHomeActivity(
          { actor, homeId: HOME, cursor: '%%%' },
          deps({
            list: () => Promise.reject(new InvalidActivityRequestError()),
          }),
        ),
      InvalidRequestError,
    );
  });

  void it('conceals a Home-scope mismatch without reading Activity', async () => {
    await assert.rejects(
      () =>
        listHomeActivity(
          { actor, homeId: OTHER_HOME },
          { ...deps(), activity: { listVisiblePageByHome: unusedList } },
        ),
      ConcealedNotFoundError,
    );
  });

  void it('projects all seven event types without private Maintenance content', async () => {
    const listed = await listHomeActivity(
      { actor, homeId: HOME },
      deps({
        page: page({
          items: [
            activity({
              id: 'm-created',
              eventType: 'maintenance.created.v1',
              sourceEntityType: 'MAINTENANCE',
              sourceEntityId: HOUSEHOLD,
              actorMembershipId: ALEX,
            }),
            activity({
              id: 'm-resolved',
              eventType: 'maintenance.resolved.v1',
              sourceEntityType: 'MAINTENANCE',
              sourceEntityId: PRIVATE_MAINT,
              actorMembershipId: ALEX,
            }),
            activity({
              id: 'task',
              eventType: 'task.completed.v1',
              sourceEntityType: 'TASK',
              sourceEntityId: TASK,
            }),
            activity({
              id: 'supply',
              eventType: 'supply.obtained.v1',
              sourceEntityType: 'SUPPLY',
              sourceEntityId: SUPPLY,
            }),
            activity({
              id: 'started',
              eventType: 'membership.started.v1',
              sourceEntityType: 'MEMBERSHIP',
              sourceEntityId: ALEX,
              actorMembershipId: ALEX,
            }),
            activity({
              id: 'ended',
              eventType: 'membership.ended.v1',
              sourceEntityType: 'MEMBERSHIP',
              sourceEntityId: ALEX,
              actorMembershipId: TAYLOR,
            }),
            activity({
              id: 'role',
              eventType: 'membership.role_changed.v1',
              sourceEntityType: 'MEMBERSHIP',
              sourceEntityId: ALEX,
              actorMembershipId: TAYLOR,
            }),
          ],
        }),
        memberships: memberships([
          { membershipId: ALEX, name: 'Alex' },
          { membershipId: TAYLOR, name: 'Taylor' },
        ]),
      }),
    );
    assert.deepEqual(
      listed.items.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        sourceTitle: row.sourceTitle,
        actorId: row.actor?.membershipId ?? null,
        actorName: row.actor?.name ?? null,
        subjectId: row.subject?.membershipId ?? null,
        subjectName: row.subject?.name ?? null,
      })),
      [
        {
          id: 'm-created',
          eventType: 'maintenance.created.v1',
          sourceTitle: 'Leak',
          actorId: ALEX,
          actorName: 'Alex',
          subjectId: null,
          subjectName: null,
        },
        {
          id: 'm-resolved',
          eventType: 'maintenance.resolved.v1',
          sourceTitle: null,
          actorId: ALEX,
          actorName: 'Alex',
          subjectId: null,
          subjectName: null,
        },
        {
          id: 'task',
          eventType: 'task.completed.v1',
          sourceTitle: 'Trash',
          actorId: ALEX,
          actorName: 'Alex',
          subjectId: null,
          subjectName: null,
        },
        {
          id: 'supply',
          eventType: 'supply.obtained.v1',
          sourceTitle: 'Milk',
          actorId: ALEX,
          actorName: 'Alex',
          subjectId: null,
          subjectName: null,
        },
        {
          id: 'started',
          eventType: 'membership.started.v1',
          sourceTitle: null,
          actorId: ALEX,
          actorName: 'Alex',
          subjectId: ALEX,
          subjectName: 'Alex',
        },
        {
          id: 'ended',
          eventType: 'membership.ended.v1',
          sourceTitle: null,
          actorId: TAYLOR,
          actorName: 'Taylor',
          subjectId: ALEX,
          subjectName: 'Alex',
        },
        {
          id: 'role',
          eventType: 'membership.role_changed.v1',
          sourceTitle: null,
          actorId: TAYLOR,
          actorName: 'Taylor',
          subjectId: ALEX,
          subjectName: 'Alex',
        },
      ],
    );
    for (const row of listed.items) {
      assert.equal('oldRole' in row, false);
      assert.equal('newRole' in row, false);
      assert.equal('details' in row, false);
      assert.equal('audienceMembershipIds' in row, false);
      assert.equal('userId' in row, false);
    }
    assert.notEqual(
      listed.items[5]?.actor?.membershipId,
      listed.items[5]?.subject?.membershipId,
    );
  });

  void it('keeps missing-source rows and anonymized actors after pagination', async () => {
    const listed = await listHomeActivity(
      { actor, homeId: HOME },
      deps({
        page: page({
          items: [
            activity({
              id: 'missing',
              sourceEntityId: MISSING_TASK,
              actorMembershipId: TAYLOR,
            }),
          ],
        }),
        memberships: memberships([{ membershipId: TAYLOR, name: null }]),
        tasks: new Map(),
      }),
    );
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.id, 'missing');
    assert.equal(listed.items[0]?.sourceTitle, null);
    assert.equal(listed.items[0]?.actor?.membershipId, TAYLOR);
    assert.equal(listed.items[0]?.actor?.name, null);
  });
});

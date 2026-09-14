import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NOTIFICATION_LIST_DEFAULT_LIMIT } from '../../domains/notifications/cursor.js';
import { InvalidNotificationRequestError } from '../../domains/notifications/errors.js';
import type {
  EligibleNotification,
  NotificationRepositoryPage,
} from '../../domains/notifications/notification-list-item.js';
import type { ListEligibleNotificationPage } from '../../domains/notifications/repository.js';
import type { HistoricalMembershipDisplay } from '../../domains/memberships/find-historical-membership-display.js';
import { InvalidRequestError } from '../../platform/authz/errors.js';
import { listCurrentUserNotifications } from './list-current-user-notifications.js';

const USER = '11111111-1111-4111-8111-111111111111';
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALEX = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK = '018f1e2c-7e3a-7000-8000-1234567890ab';
const SUPPLY = '018f1e2c-7e3a-7000-8000-1234567890ac';
const PRIVATE = '018f1e2c-7e3a-7000-8000-1234567890ad';
const OCCURRED = new Date('2026-09-13T18:00:00.000Z');

function eligible(
  overrides: Partial<EligibleNotification> = {},
): EligibleNotification {
  return {
    id: TASK,
    homeId: HOME,
    recipientMembershipId: ALEX,
    sourceOutboxEventId: '018f1e2c-7e3a-7000-8000-1234567890c0',
    kind: 'ASSIGNED_TASK_COMPLETED',
    sourceEntityType: 'TASK',
    sourceEntityId: TASK,
    actorMembershipId: ALEX,
    occurredAt: OCCURRED,
    createdAt: OCCURRED,
    readAt: null,
    homeName: 'Home A',
    ...overrides,
  };
}

function page(
  overrides: Partial<NotificationRepositoryPage> = {},
): NotificationRepositoryPage {
  return {
    items: [eligible()],
    hasMore: false,
    nextCursor: null,
    ...overrides,
  };
}

void describe('listCurrentUserNotifications', () => {
  void it('projects Task and Supply titles only after repository eligibility', async () => {
    const listed: ListEligibleNotificationPage[] = [];
    const result = await listCurrentUserNotifications(
      { userId: USER },
      {
        notifications: {
          listEligiblePageForUser(input) {
            listed.push(input);
            return Promise.resolve(
              page({
                items: [
                  eligible(),
                  eligible({
                    id: SUPPLY,
                    kind: 'CREATED_SUPPLY_OBTAINED',
                    sourceEntityType: 'SUPPLY',
                    sourceEntityId: SUPPLY,
                  }),
                ],
              }),
            );
          },
        },
        findHistoricalMembershipDisplays: () =>
          Promise.resolve(
            new Map<string, HistoricalMembershipDisplay>([
              [ALEX, { membershipId: ALEX, name: 'Alex' }],
            ]),
          ),
        findTaskActivityDisplays: () =>
          Promise.resolve(
            new Map([[TASK, { id: TASK, title: 'Take out trash' }]]),
          ),
        findSupplyActivityDisplays: () =>
          Promise.resolve(new Map([[SUPPLY, { id: SUPPLY, title: 'Milk' }]])),
      },
    );
    assert.deepEqual(listed, [
      { userId: USER, limit: NOTIFICATION_LIST_DEFAULT_LIMIT },
    ]);
    assert.equal(result.items[0]?.source?.type, 'TASK');
    assert.equal(result.items[0]?.actor?.name, 'Alex');
    assert.equal(result.items[1]?.source?.type, 'SUPPLY');
    assert.equal('membershipId' in (result.items[0]?.actor ?? {}), false);
  });

  void it('uses generic fallbacks and never resolves PRIVATE Maintenance titles', async () => {
    let maintenanceCalled = false;
    const result = await listCurrentUserNotifications(
      { userId: USER },
      {
        notifications: {
          listEligiblePageForUser: () =>
            Promise.resolve(
              page({
                items: [
                  eligible({
                    id: PRIVATE,
                    kind: 'PRIVATE_MAINTENANCE_CREATED',
                    sourceEntityType: 'MAINTENANCE',
                    sourceEntityId: PRIVATE,
                  }),
                  eligible({
                    id: TASK,
                    sourceEntityId: TASK,
                    actorMembershipId: null,
                  }),
                ],
              }),
            ),
        },
        findHistoricalMembershipDisplays: () => Promise.resolve(new Map()),
        findTaskActivityDisplays: () => Promise.resolve(new Map()),
        findSupplyActivityDisplays: () => {
          maintenanceCalled = true;
          return Promise.resolve(new Map());
        },
      },
    );
    void maintenanceCalled;
    assert.equal(result.items[0]?.source, null);
    assert.deepEqual(result.items[0]?.destination, {
      type: 'HOME',
      homeId: HOME,
    });
    assert.equal(result.items[1]?.source, null);
    assert.equal(result.items[1]?.actor, null);
  });

  void it('maps a malformed cursor to InvalidRequestError', async () => {
    await assert.rejects(
      () =>
        listCurrentUserNotifications(
          { userId: USER, cursor: '%%%' },
          {
            notifications: {
              listEligiblePageForUser: () =>
                Promise.reject(new InvalidNotificationRequestError()),
            },
            findHistoricalMembershipDisplays: () => {
              throw new Error('must not resolve displays before eligibility');
            },
            findTaskActivityDisplays: () => {
              throw new Error('must not resolve displays before eligibility');
            },
            findSupplyActivityDisplays: () => {
              throw new Error('must not resolve displays before eligibility');
            },
          },
        ),
      InvalidRequestError,
    );
  });
});

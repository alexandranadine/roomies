import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';
const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'final-polish');

const LONG_NAME =
  'Jamie With An Exceptionally Long Roommate Display Name For Wrapping';
const LONG_TITLE =
  'Take out the overflowing recycling and compost bins from the side alley every Wednesday evening';
const LONG_EMAIL = 'alexandra.nadine.lewis+roomies-household@example.com';
const DISPLAY_NAME = 'Alexandra Nadine Lewis';

type Shot = {
  name: string;
  path: string;
  ready: (page: Page) => Promise<void>;
};

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockUnauthenticated(page: Page): Promise<void> {
  await page.route('**/api/v1/me', async (route) => {
    await json(route, 401, {
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  });
  await page.route('**/api/auth/get-session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: 'null',
    });
  });
}

async function mockAuthenticatedApp(page: Page): Promise<void> {
  await page.route('**/api/auth/get-session', async (route) => {
    if (route.request().method().toUpperCase() !== 'GET') {
      await route.fallback();
      return;
    }
    await json(route, 200, {
      user: {
        id: USER_ID,
        name: DISPLAY_NAME,
        email: LONG_EMAIL,
        emailVerified: true,
      },
    });
  });

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const pathName = url.pathname;
    const method = route.request().method().toUpperCase();

    if (pathName === '/api/v1/me' && method === 'GET') {
      await json(route, 200, { id: USER_ID });
      return;
    }
    if (pathName === '/api/v1/me/homes' && method === 'GET') {
      await json(route, 200, [
        {
          id: HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          role: 'ADMIN',
          hasPhoto: false,
        },
      ]);
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}` && method === 'GET') {
      await json(route, 200, {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: false,
      });
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/memberships` && method === 'GET') {
      await json(route, 200, {
        currentMembershipId: MEMBERSHIP_A,
        memberships: [
          { membershipId: MEMBERSHIP_A, name: DISPLAY_NAME },
          { membershipId: MEMBERSHIP_B, name: 'Jamie' },
        ],
      });
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/pulse`) {
      await json(route, 200, {
        generatedAt: '2026-09-14T04:00:00.000Z',
        homeLocalDate: '2026-09-14',
        items: [
          {
            type: 'TASKS',
            state: 'ACTIVE',
            assignedOpenCount: 2,
            unassignedOpenCount: 1,
            dueTodayRelevantCount: 1,
            overdueRelevantCount: 3,
          },
          {
            type: 'SUPPLIES',
            state: 'ACTIVE',
            openCount: 4,
            unclaimedOpenCount: 2,
            claimedByMeCount: 1,
          },
          {
            type: 'MAINTENANCE',
            state: 'ACTIVE',
            openVisibleCount: 2,
          },
        ],
      });
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/activity`) {
      await json(route, 200, {
        items: [
          {
            id: 'a1111111-1111-4111-8111-111111111111',
            eventType: 'task.completed.v1',
            sourceEntityType: 'TASK',
            sourceEntityId: 't1111111-1111-4111-8111-111111111111',
            occurredAt: '2026-09-13T18:00:00.000Z',
            actor: { membershipId: MEMBERSHIP_A, name: LONG_NAME },
            sourceTitle: LONG_TITLE,
            subject: null,
          },
          {
            id: 'a2222222-2222-4222-8222-222222222222',
            eventType: 'maintenance.created.v1',
            sourceEntityType: 'MAINTENANCE',
            sourceEntityId: 'n1111111-1111-4111-8111-111111111111',
            occurredAt: '2026-09-13T16:00:00.000Z',
            actor: { membershipId: MEMBERSHIP_A, name: 'Alex' },
            sourceTitle: 'Quiet leak under sink',
            subject: null,
          },
          {
            id: 'a3333333-3333-4333-8333-333333333333',
            eventType: 'membership.ended.v1',
            sourceEntityType: 'MEMBERSHIP',
            sourceEntityId: MEMBERSHIP_B,
            occurredAt: '2026-09-13T13:00:00.000Z',
            actor: { membershipId: MEMBERSHIP_A, name: null },
            subject: { membershipId: MEMBERSHIP_B, name: null },
            sourceTitle: null,
          },
          {
            id: 'a6666666-6666-4666-8666-666666666666',
            eventType: 'membership.started.v1',
            sourceEntityType: 'MEMBERSHIP',
            sourceEntityId: MEMBERSHIP_B,
            occurredAt: '2026-09-13T12:00:00.000Z',
            actor: { membershipId: MEMBERSHIP_B, name: 'Jamie' },
            subject: { membershipId: MEMBERSHIP_B, name: 'Jamie' },
            sourceTitle: null,
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/tasks` && method === 'GET') {
      await json(route, 200, [
        {
          id: 't1111111-1111-4111-8111-111111111111',
          title: 'Take out trash',
          status: 'OPEN',
          source: 'MANUAL',
          scheduledFor: '2020-01-15',
          assignedMembershipId: MEMBERSHIP_B,
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-09-10T15:30:00.000Z',
        },
        {
          id: 't2222222-2222-4222-8222-222222222222',
          title: 'Wipe counters',
          status: 'OPEN',
          source: 'MANUAL',
          scheduledFor: null,
          assignedMembershipId: null,
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-09-10T15:30:00.000Z',
        },
        {
          id: 't4444444-4444-4444-8444-444444444444',
          title: 'Sweep hallway',
          status: 'COMPLETED',
          source: 'MANUAL',
          scheduledFor: '2026-09-10',
          assignedMembershipId: MEMBERSHIP_B,
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-09-10T18:00:00.000Z',
        },
      ]);
      return;
    }
    if (
      pathName === `/api/v1/homes/${HOME_A}/task-definitions` &&
      method === 'GET'
    ) {
      await json(route, 200, [
        {
          id: 'd1111111-1111-4111-8111-111111111111',
          title: 'Weekly trash',
          frequency: 'WEEKLY',
          weekday: 2,
          dayOfMonth: null,
          assignedMembershipId: MEMBERSHIP_B,
          creatorMembershipId: MEMBERSHIP_A,
          nextOccurrenceDate: '2026-09-29',
          deactivatedAt: null,
          createdAt: '2026-09-01T12:00:00.000Z',
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
      ]);
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/maintenance` && method === 'GET') {
      await json(route, 200, {
        items: [
          {
            id: 'h1111111-1111-4111-8111-111111111111',
            title: 'Replace furnace filter',
            status: 'OPEN',
            visibility: 'HOUSEHOLD',
            createdByMembershipId: MEMBERSHIP_A,
            resolvedByMembershipId: null,
            resolvedAt: null,
            createdAt: '2026-09-01T12:00:00.000Z',
            updatedAt: '2026-09-12T10:00:00.000Z',
          },
          {
            id: 'a1111111-1111-4111-8111-111111111111',
            title: 'Quiet leak under sink',
            status: 'OPEN',
            visibility: 'PRIVATE',
            createdByMembershipId: MEMBERSHIP_A,
            resolvedByMembershipId: null,
            resolvedAt: null,
            createdAt: '2026-09-01T12:00:00.000Z',
            updatedAt: '2026-09-11T09:00:00.000Z',
          },
          {
            id: 'r1111111-1111-4111-8111-111111111111',
            title: 'Fixed hallway light',
            status: 'RESOLVED',
            visibility: 'HOUSEHOLD',
            createdByMembershipId: MEMBERSHIP_A,
            resolvedByMembershipId: MEMBERSHIP_B,
            resolvedAt: '2026-09-09T18:00:00.000Z',
            createdAt: '2026-09-01T12:00:00.000Z',
            updatedAt: '2026-09-09T18:00:00.000Z',
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
      return;
    }
    if (pathName === '/api/v1/notifications' && method === 'GET') {
      await json(route, 200, {
        items: [
          {
            id: 'n1111111-1111-4111-8111-111111111111',
            kind: 'ASSIGNED_TASK_COMPLETED',
            occurredAt: '2026-09-13T18:00:00.000Z',
            readAt: null,
            home: { id: HOME_A, name: 'Oak Street' },
            actor: { name: LONG_NAME },
            source: { type: 'TASK', title: LONG_TITLE },
            destination: {
              type: 'TASK',
              homeId: HOME_A,
              taskInstanceId: 't1111111-1111-4111-8111-111111111111',
            },
          },
          {
            id: 'n2222222-2222-4222-8222-222222222222',
            kind: 'PRIVATE_MAINTENANCE_CREATED',
            occurredAt: '2026-09-13T16:00:00.000Z',
            readAt: null,
            home: { id: HOME_A, name: 'Oak Street' },
            actor: null,
            source: null,
            destination: { type: 'HOME', homeId: HOME_A },
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
      return;
    }

    await json(route, 404, {
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });
  expect(
    overflow.scrollWidth,
    `Unexpected horizontal overflow (${overflow.scrollWidth} > ${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function assertNoSeriousAxeViolations(
  page: Page,
  label: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious,
    `${label} serious/critical axe violations:\n${serious
      .map((v) => `${v.id}: ${v.help}`)
      .join('\n')}`,
  ).toEqual([]);
}

async function capture(
  page: Page,
  filename: string,
  fullPage: boolean,
): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, filename),
    fullPage,
  });
}

const AUTH_SHOTS: Shot[] = [
  {
    name: 'Home',
    path: `/homes/${HOME_A}`,
    ready: async (page) => {
      await expect(page.getByTestId('house-pulse')).toBeVisible();
      await expect(page.getByRole('link', { name: 'See all' })).toBeVisible();
    },
  },
  {
    name: 'Tasks',
    path: `/homes/${HOME_A}/tasks`,
    ready: async (page) => {
      await expect(
        page.getByRole('heading', { name: 'Tasks', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Take out trash')).toBeVisible();
    },
  },
  {
    name: 'Roommates',
    path: `/homes/${HOME_A}/roommates`,
    ready: async (page) => {
      await expect(
        page.getByRole('heading', { name: 'Roommates', level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByText('The people sharing this Home.'),
      ).toBeVisible();
    },
  },
  {
    name: 'Notifications',
    path: '/notifications',
    ready: async (page) => {
      await expect(
        page.getByRole('heading', { name: 'Notifications', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('New private maintenance update')).toBeVisible();
    },
  },
  {
    name: 'Account',
    path: '/account',
    ready: async (page) => {
      await expect(
        page.getByRole('heading', { name: 'Account', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(LONG_EMAIL)).toBeVisible();
    },
  },
  {
    name: 'Maintenance',
    path: `/homes/${HOME_A}/maintenance`,
    ready: async (page) => {
      await expect(
        page.getByRole('heading', { name: 'Maintenance', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Quiet leak under sink')).toBeVisible();
      await expect(page.getByText('Invisible private item B')).toHaveCount(0);
    },
  },
  {
    name: 'Activity',
    path: `/homes/${HOME_A}/activity`,
    ready: async (page) => {
      await expect(
        page.getByRole('heading', { name: 'Activity', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Former roommate left the home')).toBeVisible();
      await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
    },
  },
];

test.describe('final polish screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedApp(page);
  });

  for (const shot of AUTH_SHOTS) {
    test(`${shot.name} 390 screenshot`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(shot.path);
      await shot.ready(page);
      await assertNoHorizontalOverflow(page);
      await capture(page, `${shot.name.toLowerCase()}-390.png`, false);
    });

    test(`${shot.name} 1440 screenshot`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(shot.path);
      await shot.ready(page);
      await assertNoHorizontalOverflow(page);
      await capture(page, `${shot.name.toLowerCase()}-1440.png`, true);
    });
  }
});

test.describe('final polish axe', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedApp(page);
  });

  for (const shot of AUTH_SHOTS) {
    test(`${shot.name} axe scan (serious/critical)`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(shot.path);
      await shot.ready(page);
      await assertNoSeriousAxeViolations(page, shot.name);
    });
  }
});

test.describe('final polish sign-in and not-found', () => {
  test('sign in 390 screenshot and axe', async ({ page }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await assertNoSeriousAxeViolations(page, 'sign in');
    await capture(page, 'signin-390.png', false);
  });

  test('not-found is a standalone canvas without in-app chrome', async ({
    page,
  }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/does-not-exist');
    await expect(
      page.getByRole('heading', { name: 'Page not found', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to Roomies' })).toBeVisible();
    await expect(page.getByText('does-not-exist')).toHaveCount(0);
    await assertNoSeriousAxeViolations(page, 'not found');
  });
});

test.describe('final polish navigation and overflow', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedApp(page);
  });

  test('mobile bottom nav reaches Home, Tasks, House, and Profile', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(page.getByTestId('house-pulse')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Home' });
    await nav.getByRole('link', { name: 'Tasks' }).click();
    await expect(
      page.getByRole('heading', { name: 'Tasks', level: 1 }),
    ).toBeVisible();
    await nav.getByRole('link', { name: 'Roommates' }).click();
    await expect(
      page.getByRole('heading', { name: 'Roommates', level: 1 }),
    ).toBeVisible();
    await nav.getByRole('link', { name: 'Account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Account', level: 1 }),
    ).toBeVisible();
    await page.goto(`/homes/${HOME_A}`);
    await page.getByRole('link', { name: 'See all' }).click();
    await expect(
      page.getByRole('heading', { name: 'Activity', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
  });

  test('signed-in not-found stays a canvas without the in-app header', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/does-not-exist');
    await expect(
      page.getByRole('heading', { name: 'Page not found', level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Notifications/ })).toHaveCount(
      0,
    );
  });

  test('desktop header nav reaches Tasks, House, Profile, and Notifications', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(page.getByTestId('house-pulse')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Home' });
    await nav.getByRole('link', { name: 'Tasks' }).click();
    await expect(
      page.getByRole('heading', { name: 'Tasks', level: 1 }),
    ).toBeVisible();
    await nav.getByRole('link', { name: 'Roommates' }).click();
    await expect(
      page.getByRole('heading', { name: 'Roommates', level: 1 }),
    ).toBeVisible();
    await nav.getByRole('link', { name: 'Account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Account', level: 1 }),
    ).toBeVisible();
    await page.getByRole('link', { name: /Notifications/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeVisible();
  });

  for (const viewport of [
    { name: '360', width: 360, height: 800 },
    { name: '768', width: 768, height: 1024 },
    { name: '1024', width: 1024, height: 800 },
    { name: '1280', width: 1280, height: 800 },
  ] as const) {
    test(`Home has no horizontal overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}`);
      await expect(page.getByTestId('house-pulse')).toBeVisible();
      await assertNoHorizontalOverflow(page);
    });
  }
});

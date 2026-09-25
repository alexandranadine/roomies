import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';
const MEMBERSHIP_C = 'm3333333-3333-4333-8333-333333333333';

const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'activity-phase-8');
const SCREENSHOT_VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const VIEWPORTS = [
  ...SCREENSHOT_VIEWPORTS,
  { name: '430', width: 430, height: 932 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
] as const;

const LONG_NAME =
  'Jamie With An Exceptionally Long Roommate Display Name For Wrapping';
const LONG_TITLE =
  'Take out the overflowing recycling and compost bins from the side alley every Wednesday evening';

const PAGE_ONE = {
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
      id: 'a5555555-5555-4555-8555-555555555555',
      eventType: 'membership.role_changed.v1',
      sourceEntityType: 'MEMBERSHIP',
      sourceEntityId: MEMBERSHIP_B,
      occurredAt: '2026-09-13T12:30:00.000Z',
      actor: { membershipId: MEMBERSHIP_C, name: 'Taylor' },
      subject: { membershipId: MEMBERSHIP_B, name: 'Jamie' },
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
    {
      id: 'a7777777-7777-4777-8777-777777777777',
      eventType: 'maintenance.resolved.v1',
      sourceEntityType: 'MAINTENANCE',
      sourceEntityId: 'n2222222-2222-4222-8222-222222222222',
      occurredAt: '2026-09-13T11:00:00.000Z',
      actor: { membershipId: MEMBERSHIP_A, name: 'Alex' },
      sourceTitle: 'Quiet leak under sink',
      subject: null,
    },
    {
      id: 'a8888888-8888-4888-8888-888888888888',
      eventType: 'task.completed.v1',
      sourceEntityType: 'TASK',
      sourceEntityId: 't3333333-3333-4333-8333-333333333333',
      occurredAt: '2026-09-13T10:00:00.000Z',
      actor: null,
      sourceTitle: null,
      subject: null,
    },
  ],
  hasMore: true,
  nextCursor: 'cursor-page-2',
};

const PAGE_TWO = {
  items: [
    {
      id: 'a4444444-4444-4444-8444-444444444444',
      eventType: 'supply.obtained.v1',
      sourceEntityType: 'SUPPLY',
      sourceEntityId: 's1111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-13T09:00:00.000Z',
      actor: { membershipId: MEMBERSHIP_A, name: 'Alex' },
      sourceTitle: 'Paper towels',
      subject: null,
    },
  ],
  hasMore: false,
  nextCursor: null,
};

const HOME_B_PAGE = {
  items: [
    {
      id: 'b1111111-1111-4111-8111-111111111111',
      eventType: 'task.completed.v1',
      sourceEntityType: 'TASK',
      sourceEntityId: 't2222222-2222-4222-8222-222222222222',
      occurredAt: '2026-09-12T18:00:00.000Z',
      actor: { membershipId: MEMBERSHIP_B, name: 'Casey' },
      sourceTitle: 'Water the plants',
      subject: null,
    },
  ],
  hasMore: false,
  nextCursor: null,
};

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuthenticatedActivityApis(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith('/api/v1/me')) {
      await json(route, 200, { id: USER_ID });
      return;
    }
    if (path.endsWith('/api/v1/me/homes')) {
      await json(route, 200, [
        {
          id: HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          role: 'ADMIN',
          hasPhoto: false,
        },
        {
          id: HOME_B,
          name: 'Cedar House',
          timezone: 'UTC',
          role: 'ROOMMATE',
          hasPhoto: false,
        },
      ]);
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}/activity`) {
      const cursor = url.searchParams.get('cursor');
      await json(route, 200, cursor === 'cursor-page-2' ? PAGE_TWO : PAGE_ONE);
      return;
    }
    if (path === `/api/v1/homes/${HOME_B}/activity`) {
      await json(route, 200, HOME_B_PAGE);
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}/pulse`) {
      await json(route, 200, {
        generatedAt: '2026-09-14T04:00:00.000Z',
        homeLocalDate: '2026-09-14',
        items: [
          {
            type: 'TASKS',
            state: 'CLEAR',
            assignedOpenCount: 0,
            unassignedOpenCount: 0,
            dueTodayRelevantCount: 0,
            overdueRelevantCount: 0,
          },
          {
            type: 'SUPPLIES',
            state: 'CLEAR',
            openCount: 0,
            unclaimedOpenCount: 0,
            claimedByMeCount: 0,
          },
          {
            type: 'MAINTENANCE',
            state: 'CLEAR',
            openVisibleCount: 0,
          },
        ],
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_B}/pulse`) {
      await json(route, 200, {
        generatedAt: '2026-09-14T04:00:00.000Z',
        homeLocalDate: '2026-09-14',
        items: [
          {
            type: 'TASKS',
            state: 'CLEAR',
            assignedOpenCount: 0,
            unassignedOpenCount: 0,
            dueTodayRelevantCount: 0,
            overdueRelevantCount: 0,
          },
          {
            type: 'SUPPLIES',
            state: 'CLEAR',
            openCount: 0,
            unclaimedOpenCount: 0,
            claimedByMeCount: 0,
          },
          {
            type: 'MAINTENANCE',
            state: 'CLEAR',
            openVisibleCount: 0,
          },
        ],
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}`) {
      await json(route, 200, {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: false,
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_B}`) {
      await json(route, 200, {
        id: HOME_B,
        name: 'Cedar House',
        timezone: 'UTC',
        hasPhoto: false,
      });
      return;
    }
    if (path === '/api/v1/notifications') {
      await json(route, 200, { items: [], hasMore: false, nextCursor: null });
      return;
    }
    if (path.endsWith('/memberships')) {
      await json(route, 200, {
        currentMembershipId: MEMBERSHIP_A,
        memberships: [
          { membershipId: MEMBERSHIP_A, name: 'Alex' },
          { membershipId: MEMBERSHIP_B, name: 'Jamie' },
        ],
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

async function assertDesktopContentWidth(page: Page): Promise<void> {
  const width = await page
    .getByTestId('activity-page')
    .evaluate((element) => {
      return element.getBoundingClientRect().width;
    });
  expect(width).toBeLessThanOrEqual(900);
  expect(width).toBeGreaterThan(700);
}

async function assertContentClearOfBottomNav(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Home' });
  if ((await nav.count()) === 0) {
    return;
  }

  const position = await nav.evaluate((element) => {
    return window.getComputedStyle(element).position;
  });
  if (position !== 'fixed') {
    return;
  }

  const paddingBottom = await page
    .getByTestId('activity-page')
    .evaluate((element) => {
      let node: HTMLElement | null = element;
      while (node) {
        const value = Number.parseFloat(
          window.getComputedStyle(node).paddingBottom,
        );
        if (value >= 80) {
          return value;
        }
        node = node.parentElement;
      }
      return 0;
    });
  expect(paddingBottom).toBeGreaterThanOrEqual(80);
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

test.describe('Activity authenticated UI', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedActivityApis(page);
  });

  for (const viewport of VIEWPORTS) {
    test(`list has no horizontal overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}/activity`);
      await expect(
        page.getByRole('heading', { name: 'Activity', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(LONG_NAME)).toBeVisible();
      await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
      await assertNoHorizontalOverflow(page);
    });
  }

  for (const viewport of SCREENSHOT_VIEWPORTS) {
    test(`populated Activity at ${viewport.name}px`, async ({ page }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}/activity`);
      await expect(
        page.getByRole('heading', { name: 'Activity', level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByText('What’s been happening around the house.'),
      ).toBeVisible();
      await expect(page.getByText(LONG_NAME)).toBeVisible();
      await expect(page.getByText(LONG_TITLE)).toBeVisible();
      await expect(page.getByText('Former roommate left the home')).toBeVisible();
      await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
      await expect(page.getByText(MEMBERSHIP_A)).toHaveCount(0);
      await expect(page.getByText(MEMBERSHIP_B)).toHaveCount(0);
      await assertNoHorizontalOverflow(page);
      if (viewport.width >= 1024) {
        await assertDesktopContentWidth(page);
        const titleBox = await page.getByText(LONG_TITLE).boundingBox();
        expect(titleBox).not.toBeNull();
        expect(titleBox!.width).toBeGreaterThan(200);
      }
      if (viewport.width < 768) {
        await assertContentClearOfBottomNav(page);
      }
      const nameBox = await page.getByText(LONG_NAME).boundingBox();
      expect(nameBox).not.toBeNull();
      expect(nameBox!.width).toBeLessThanOrEqual(viewport.width);
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `activity-${viewport.name}.png`),
        fullPage: true,
      });
    });
  }

  test('list axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/homes/${HOME_A}/activity`);
    await expect(
      page.getByRole('heading', { name: 'Activity', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(LONG_NAME)).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'activity list');
  });

  test('200% zoom does not force horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/homes/${HOME_A}/activity`);
    await expect(
      page.getByRole('heading', { name: 'Activity', level: 1 }),
    ).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    await assertNoHorizontalOverflow(page);
  });

  test('keyboard can open Activity and activate Load more', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(
      page.getByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'See all' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Activity', level: 1 }),
    ).toBeVisible();

    const loadMore = page.getByRole('button', { name: 'Load more' });
    await loadMore.focus();
    await expect(loadMore).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Paper towels')).toBeVisible();
    await expect(page.getByText('marked a supply obtained')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(
      0,
    );
  });

  test('reduced motion still renders the feed', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`/homes/${HOME_A}/activity`);
    await expect(
      page.getByRole('heading', { name: 'Activity', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Former roommate left the home')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('Home switch does not keep the previous Home rows', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(`/homes/${HOME_A}/activity`);
    await expect(page.getByText(LONG_TITLE)).toBeVisible();

    await page.goto(`/homes/${HOME_B}/activity`);
    await expect(page.getByText('Water the plants')).toBeVisible();
    await expect(page.getByText('Casey')).toBeVisible();
    await expect(page.getByText(LONG_TITLE)).toHaveCount(0);
    await expect(page.getByText('Alex added a maintenance item')).toHaveCount(
      0,
    );
  });

  test('long names, titles, and null identity wrap without leaking IDs', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/homes/${HOME_A}/activity`);
    await expect(
      page.getByRole('heading', { name: 'Activity', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(LONG_NAME)).toBeVisible();
    await expect(page.getByText(LONG_TITLE)).toBeVisible();
    await expect(page.getByText('Former roommate left the home')).toBeVisible();
    await expect(page.getByText('A task was completed')).toBeVisible();
    await expect(page.getByText(MEMBERSHIP_A)).toHaveCount(0);
    await expect(page.getByText(MEMBERSHIP_B)).toHaveCount(0);
    await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await assertContentClearOfBottomNav(page);
    await assertNoSeriousAxeViolations(page, 'activity long content');
  });

  test('shared Maintenance Activity links to the existing detail route', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/activity`);
    await expect(
      page.getByRole('link', { name: 'View maintenance' }),
    ).toHaveCount(0);

    const maintenanceLinks = page.getByRole('link', { name: 'maintenance item' });
    await expect(maintenanceLinks).toHaveCount(2);
    await expect(maintenanceLinks.first()).toBeVisible();
    await expect(maintenanceLinks.first()).toHaveAttribute(
      'href',
      `/homes/${HOME_A}/maintenance/n1111111-1111-4111-8111-111111111111`,
    );
    await expect(maintenanceLinks.nth(1)).toHaveAttribute(
      'href',
      `/homes/${HOME_A}/maintenance/n2222222-2222-4222-8222-222222222222`,
    );
    await expect(page.getByText('n1111111-1111-4111-8111-111111111111')).toHaveCount(
      0,
    );
    await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
  });

  test('private Maintenance Activity does not expose a Maintenance link', async ({
    page,
  }) => {
    await page.route(`**/api/v1/homes/${HOME_A}/activity`, async (route) => {
      await json(route, 200, {
        items: [
          {
            id: 'a9999999-9999-4999-8999-999999999999',
            eventType: 'maintenance.created.v1',
            sourceEntityType: 'MAINTENANCE',
            sourceEntityId: 'n3333333-3333-4333-8333-333333333333',
            occurredAt: '2026-09-13T15:00:00.000Z',
            actor: { membershipId: MEMBERSHIP_A, name: 'Alex' },
            sourceTitle: null,
            subject: null,
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/activity`);
    await expect(page.getByText('Alex added a maintenance item')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'maintenance item' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'View maintenance' }),
    ).toHaveCount(0);
    await expect(page.getByText('n3333333-3333-4333-8333-333333333333')).toHaveCount(
      0,
    );
  });
});

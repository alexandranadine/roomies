import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 't1111111-1111-4111-8111-111111111111';
const SUPPLY_ID = 's1111111-1111-4111-8111-111111111111';

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '430', width: 430, height: 932 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;

const LONG_NAME =
  'Jamie With An Exceptionally Long Roommate Display Name For Wrapping';
const LONG_TITLE =
  'Take out the overflowing recycling and compost bins from the side alley every Wednesday evening';

const PAGE_ONE = {
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
        taskInstanceId: TASK_ID,
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
    {
      id: 'n3333333-3333-4333-8333-333333333333',
      kind: 'CREATED_SUPPLY_OBTAINED',
      occurredAt: '2026-09-13T15:00:00.000Z',
      readAt: '2026-09-13T15:05:00.000Z',
      home: { id: HOME_B, name: 'Cedar House' },
      actor: { name: 'Casey' },
      source: { type: 'SUPPLY', title: 'Paper towels' },
      destination: {
        type: 'SUPPLY',
        homeId: HOME_B,
        supplyEntryId: SUPPLY_ID,
      },
    },
  ],
  hasMore: true,
  nextCursor: 'cursor-page-2',
};

const PAGE_TWO = {
  items: [
    {
      id: 'n4444444-4444-4444-8444-444444444444',
      kind: 'MEMBERSHIP_ROLE_CHANGED',
      occurredAt: '2026-09-13T12:00:00.000Z',
      readAt: null,
      home: { id: HOME_B, name: 'Cedar House' },
      actor: null,
      source: null,
      destination: { type: 'ROOMMATES', homeId: HOME_B },
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

async function mockAuthenticatedNotificationApis(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method().toUpperCase();

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
        },
        {
          id: HOME_B,
          name: 'Cedar House',
          timezone: 'UTC',
          role: 'ROOMMATE',
        },
      ]);
      return;
    }
    if (path === '/api/v1/notifications' && method === 'GET') {
      const cursor = url.searchParams.get('cursor');
      await json(route, 200, cursor === 'cursor-page-2' ? PAGE_TWO : PAGE_ONE);
      return;
    }
    if (path === '/api/v1/notifications/read-all' && method === 'POST') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (
      /^\/api\/v1\/notifications\/[^/]+\/read$/i.test(path) &&
      method === 'POST'
    ) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}`) {
      await json(route, 200, {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_B}`) {
      await json(route, 200, {
        id: HOME_B,
        name: 'Cedar House',
        timezone: 'UTC',
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

test.describe('Notifications authenticated UI', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedNotificationApis(page);
  });

  for (const viewport of VIEWPORTS) {
    test(`list has no horizontal overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/notifications');
      await expect(
        page.getByRole('heading', { name: 'Notifications', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(LONG_NAME)).toBeVisible();
      await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
      await expect(
        page.getByRole('link', { name: 'Notifications' }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
    });
  }

  test('list axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/notifications');
    await expect(
      page.getByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'notifications list');
  });

  test('200% zoom does not force horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/notifications');
    await expect(
      page.getByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    await assertNoHorizontalOverflow(page);
  });

  test('keyboard can open Notifications and activate Load more', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(
      page.getByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Notifications' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeVisible();

    const loadMore = page.getByRole('button', { name: 'Load more' });
    await loadMore.focus();
    await expect(loadMore).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Your roommate role changed')).toBeVisible();
  });

  test('reduced motion still renders the inbox', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/notifications');
    await expect(
      page.getByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText('New private maintenance update'),
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('cross-Home read row navigates to destination Home', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto('/notifications');
    await expect(
      page.getByText('Casey picked up a supply you added'),
    ).toBeVisible();

    await page
      .getByRole('button', { name: /Casey picked up a supply you added/i })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Cedar House', level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveURL(`/homes/${HOME_B}`);
  });

  test('long names and PRIVATE rows wrap without leaking IDs or maintenance titles', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/notifications');
    await expect(page.getByText(LONG_NAME)).toBeVisible();
    await expect(page.getByText(LONG_TITLE)).toBeVisible();
    await expect(
      page.getByText('New private maintenance update'),
    ).toBeVisible();
    await expect(page.getByText(TASK_ID)).toHaveCount(0);
    await expect(page.getByText(SUPPLY_ID)).toHaveCount(0);
    await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
    await expect(page.getByText(/ASSIGNED_TASK_COMPLETED/)).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await assertNoSeriousAxeViolations(page, 'notifications long content');
  });
});

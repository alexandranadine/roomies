import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = '11111111-1111-4111-8111-111111111111';

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '430', width: 430, height: 932 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;

const CLEAR_PULSE = {
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
} as const;

const ACTIVE_PULSE_A = {
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
} as const;

const ACTIVE_PULSE_B = {
  generatedAt: '2026-09-14T04:00:00.000Z',
  homeLocalDate: '2026-09-14',
  items: [
    {
      type: 'TASKS',
      state: 'ACTIVE',
      assignedOpenCount: 9,
      unassignedOpenCount: 0,
      dueTodayRelevantCount: 0,
      overdueRelevantCount: 9,
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
} as const;

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

type MockOptions = {
  pulseA?: unknown;
  pulseB?: unknown;
  delayPulseBMs?: number;
};

async function mockPulseApis(
  page: Page,
  options: MockOptions = {},
): Promise<void> {
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
    if (path === `/api/v1/homes/${HOME_A}/pulse`) {
      await json(route, 200, options.pulseA ?? ACTIVE_PULSE_A);
      return;
    }
    if (path === `/api/v1/homes/${HOME_B}/pulse`) {
      if (options.delayPulseBMs !== undefined) {
        await new Promise((resolve) => {
          setTimeout(resolve, options.delayPulseBMs);
        });
      }
      await json(route, 200, options.pulseB ?? ACTIVE_PULSE_B);
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
    if (path === `/api/v1/homes/${HOME_A}/maintenance`) {
      await json(route, 200, {
        items: [],
        hasMore: false,
        nextCursor: null,
      });
      return;
    }
    if (path === '/api/v1/notifications') {
      await json(route, 200, { items: [], hasMore: false, nextCursor: null });
      return;
    }
    if (path.endsWith('/memberships')) {
      await json(route, 200, {
        currentMembershipId: 'm1111111-1111-4111-8111-111111111111',
        memberships: [
          {
            membershipId: 'm1111111-1111-4111-8111-111111111111',
            name: 'Alex',
          },
        ],
      });
      return;
    }
    if (path.endsWith('/activity')) {
      await json(route, 200, { items: [], hasMore: false, nextCursor: null });
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

test.describe('House Pulse on Home overview', () => {
  test.beforeEach(async ({ page }) => {
    await mockPulseApis(page);
  });

  for (const viewport of VIEWPORTS) {
    test(`Pulse stays compact without overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}`);
      await expect(
        page.getByRole('heading', { name: 'House Pulse', level: 2 }),
      ).toBeVisible();
      await expect(page.getByText('Overdue')).toBeVisible();
      await expect(page.getByText('Unassigned tasks')).toBeVisible();
      await expect(
        page.getByTestId('house-pulse').getByRole('list').getByText('Maintenance'),
      ).toBeVisible();
      await expect(
        page.getByTestId('house-pulse').getByRole('link', { name: 'Open Maintenance' }),
      ).toBeVisible();
      await expect(
        page.getByTestId('house-pulse').getByRole('link', { name: 'Open Tasks' }),
      ).toHaveText('Tasks');
      if (viewport.width >= 1024) {
        await expect(page.getByText('Due today')).toBeVisible();
        await expect(page.getByText('Supplies', { exact: true })).toBeVisible();
      }
      await assertNoHorizontalOverflow(page);
    });
  }

  test('renders ACTIVE counters and CLEAR copy without scores or generatedAt', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    const pulse = page.getByTestId('house-pulse');
    await expect(pulse.getByText('Overdue')).toBeVisible();
    await expect(pulse.getByText('Unassigned tasks')).toBeVisible();
    await expect(pulse.getByRole('list').getByText('Maintenance')).toBeVisible();
    await expect(pulse.getByRole('link', { name: 'Open Maintenance' })).toBeVisible();
    await expect(pulse.getByText('2026-09-14T04:00:00.000Z')).toHaveCount(0);
    await expect(pulse.getByText(/score|rank|chart|percent/i)).toHaveCount(0);
  });

  test('keyboard can open Maintenance from Pulse', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    const pulseLink = page
      .getByTestId('house-pulse')
      .getByRole('link', { name: 'Open Maintenance' });
    await pulseLink.focus();
    await expect(pulseLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/homes/${HOME_A}/maintenance`);
  });

  test('does not flash Home A Pulse under Home B while B loads', async ({
    page,
  }) => {
    await mockPulseApis(page, {
      pulseA: ACTIVE_PULSE_A,
      pulseB: ACTIVE_PULSE_B,
      delayPulseBMs: 80,
    });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(page.getByText('Overdue')).toBeVisible();

    await page.goto(`/homes/${HOME_B}`);
    await expect(
      page.getByRole('heading', { name: 'Cedar House', level: 1 }),
    ).toBeVisible();
    await expect(page.locator('li', { hasText: 'Overdue' })).toContainText('9');
  });

  test('CLEAR Pulse still shows compact domain metrics', async ({ page }) => {
    await mockPulseApis(page, { pulseA: CLEAR_PULSE });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/homes/${HOME_A}`);
    const pulse = page.getByTestId('house-pulse');
    await expect(pulse.getByText('Due today')).toBeVisible();
    await expect(pulse.getByText('Supplies', { exact: true })).toBeVisible();
    await expect(pulse.getByRole('list').getByText('Maintenance')).toBeVisible();
    await expect(pulse.getByRole('link', { name: 'Open Maintenance' })).toBeVisible();
    await expect(pulse.getByText('Clear')).toHaveCount(0);
  });

  test('respects reduced motion for Pulse skeleton animation class', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(page.getByTestId('house-pulse')).toBeVisible();
  });

  test('Home overview Pulse axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(page.getByTestId('house-pulse')).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'House Pulse overview');
  });

  test('usable at 200% zoom without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/homes/${HOME_A}`);
    await page.evaluate(() => {
      document.documentElement.style.zoom = '200%';
    });
    await expect(page.getByTestId('house-pulse')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});

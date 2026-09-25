import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';

const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'home-phase-1');

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockHomeApis(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const pathName = url.pathname;

    if (pathName.endsWith('/api/v1/me')) {
      await json(route, 200, { id: USER_ID });
      return;
    }
    if (pathName.endsWith('/api/v1/me/homes')) {
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
    if (pathName === `/api/v1/homes/${HOME_A}`) {
      await json(route, 200, {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: false,
      });
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/memberships`) {
      await json(route, 200, {
        currentMembershipId: MEMBERSHIP_A,
        memberships: [
          { membershipId: MEMBERSHIP_A, name: 'Alex' },
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
            actor: { membershipId: MEMBERSHIP_A, name: 'Alex' },
            sourceTitle: 'Take out trash',
            subject: null,
          },
          {
            id: 'a2222222-2222-4222-8222-222222222222',
            eventType: 'membership.started.v1',
            sourceEntityType: 'MEMBERSHIP',
            sourceEntityId: MEMBERSHIP_B,
            occurredAt: '2026-09-13T14:00:00.000Z',
            actor: { membershipId: MEMBERSHIP_B, name: 'Jamie' },
            sourceTitle: null,
            subject: { membershipId: MEMBERSHIP_B, name: 'Jamie' },
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
      return;
    }
    if (pathName === '/api/v1/notifications') {
      await json(route, 200, {
        items: [
          {
            id: 'n1111111-1111-4111-8111-111111111111',
            kind: 'ASSIGNED_TASK_COMPLETED',
            occurredAt: '2026-09-13T18:00:00.000Z',
            readAt: null,
            home: { id: HOME_A, name: 'Oak Street' },
            actor: { name: 'Jamie' },
            source: { type: 'TASK', title: 'Take out trash' },
            destination: {
              type: 'TASK',
              homeId: HOME_A,
              taskInstanceId: 't1111111-1111-4111-8111-111111111111',
            },
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

test.describe('Home shell Phase 1', () => {
  test.beforeEach(async ({ page }) => {
    await mockHomeApis(page);
  });

  test('Home at 360px has no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(
      page.getByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Roomies').first()).toBeVisible();
    await expect(page.getByTestId('house-pulse')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to this Home' })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'home-360.png'),
    });
  });

  test('Home at 390px matches the restored shell composition', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(page.getByText('Roomies').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Roommates' })).toBeVisible();
    await expect(page.getByTestId('house-pulse')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'What’s on your mind, Roomies?' }),
    ).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Home activity' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to this Home' })).toBeVisible();
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'home-390.png'),
    });
  });

  test('Home on desktop uses header nav instead of a bottom bar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(page.getByText('Roomies').first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Home' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Add to this Home' }),
    ).toBeVisible();
    await expect(page.getByTestId('house-pulse')).toBeVisible();
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'home-desktop.png'),
      fullPage: true,
    });
  });

  test('Home axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(page.getByTestId('house-pulse')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      serious,
      `Home axe violations:\n${serious.map((v) => `${v.id}: ${v.help}`).join('\n')}`,
    ).toEqual([]);
  });
});

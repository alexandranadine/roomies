import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';
const CREATED_ID = 'c1111111-1111-4111-8111-111111111111';

const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'maintenance-phase-7');
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

const LONG_TITLE =
  'Take the overflowing recycling and compost bins from the side alley every Wednesday evening';

const FIXTURE_H = {
  id: 'h1111111-1111-4111-8111-111111111111',
  title: 'Replace furnace filter',
  status: 'OPEN',
  visibility: 'HOUSEHOLD',
  createdByMembershipId: MEMBERSHIP_A,
  resolvedByMembershipId: null,
  resolvedAt: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
};

const FIXTURE_R = {
  id: 'r1111111-1111-4111-8111-111111111111',
  title: 'Fixed hallway light',
  status: 'RESOLVED',
  visibility: 'HOUSEHOLD',
  createdByMembershipId: MEMBERSHIP_A,
  resolvedByMembershipId: MEMBERSHIP_B,
  resolvedAt: '2026-09-09T18:00:00.000Z',
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-09T18:00:00.000Z',
};

const FIXTURE_LONG = {
  id: 'l1111111-1111-4111-8111-111111111111',
  title: LONG_TITLE,
  status: 'OPEN',
  visibility: 'HOUSEHOLD',
  createdByMembershipId: MEMBERSHIP_A,
  resolvedByMembershipId: null,
  resolvedAt: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-10T08:00:00.000Z',
};

const FIXTURE_A = {
  id: 'a1111111-1111-4111-8111-111111111111',
  title: 'Quiet leak under sink',
  status: 'OPEN',
  visibility: 'PRIVATE',
  createdByMembershipId: MEMBERSHIP_A,
  resolvedByMembershipId: null,
  resolvedAt: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-11T09:00:00.000Z',
};

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

type MockOptions = {
  resolveFixtureAWith404?: boolean;
};

async function mockAuthenticatedMaintenanceApis(
  page: Page,
  options: MockOptions = {},
): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

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
      ]);
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
    if (path === `/api/v1/homes/${HOME_A}/memberships` && method === 'GET') {
      await json(route, 200, {
        currentMembershipId: MEMBERSHIP_A,
        memberships: [
          { membershipId: MEMBERSHIP_A, name: 'Alex' },
          { membershipId: MEMBERSHIP_B, name: 'Jamie' },
        ],
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}/maintenance` && method === 'POST') {
      const body = request.postDataJSON() as {
        visibility: string;
        title: string;
        details?: string;
        audienceMembershipIds?: string[];
      };
      await json(route, 201, {
        id: CREATED_ID,
        title: body.title,
        status: 'OPEN',
        visibility: body.visibility,
        createdByMembershipId: MEMBERSHIP_A,
        resolvedByMembershipId: null,
        resolvedAt: null,
        createdAt: '2026-09-13T12:00:00.000Z',
        updatedAt: '2026-09-13T12:00:00.000Z',
        details: body.details ?? null,
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}/maintenance` && method === 'GET') {
      await json(route, 200, {
        items: [FIXTURE_H, FIXTURE_A, FIXTURE_LONG, FIXTURE_R],
        hasMore: false,
        nextCursor: null,
      });
      return;
    }
    if (
      path === `/api/v1/homes/${HOME_A}/maintenance/${FIXTURE_A.id}/resolve` &&
      method === 'POST'
    ) {
      if (options.resolveFixtureAWith404) {
        await json(route, 404, {
          error: { code: 'NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      await json(route, 200, {
        ...FIXTURE_A,
        status: 'RESOLVED',
        resolvedAt: '2026-09-13T12:00:00.000Z',
        resolvedByMembershipId: MEMBERSHIP_A,
        details: 'Keep this between us.\nSecond line.',
      });
      return;
    }
    if (
      path === `/api/v1/homes/${HOME_A}/maintenance/${FIXTURE_H.id}/resolve` &&
      method === 'POST'
    ) {
      await json(route, 200, {
        ...FIXTURE_H,
        status: 'RESOLVED',
        resolvedAt: '2026-09-13T12:00:00.000Z',
        resolvedByMembershipId: MEMBERSHIP_A,
        details: null,
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}/maintenance/${FIXTURE_A.id}`) {
      await json(route, 200, {
        ...FIXTURE_A,
        details: 'Keep this between us.\nSecond line.',
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}/maintenance/${FIXTURE_H.id}`) {
      await json(route, 200, {
        ...FIXTURE_H,
        details: null,
      });
      return;
    }
    if (path.includes('/maintenance/')) {
      await json(route, 404, {
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
      return;
    }
    if (path === '/api/v1/notifications') {
      await json(route, 200, { items: [], hasMore: false, nextCursor: null });
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

async function assertDesktopContentWidth(page: Page): Promise<void> {
  const width = await page
    .getByTestId('maintenance-page')
    .evaluate((element) => {
      return element.getBoundingClientRect().width;
    });
  expect(width).toBeLessThanOrEqual(1050);
  expect(width).toBeGreaterThan(800);
}

async function assertContentClearOfBottomNav(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Home' });
  const position = await nav.evaluate((element) => {
    return window.getComputedStyle(element).position;
  });
  if (position !== 'fixed') {
    return;
  }

  const paddingBottom = await page
    .getByTestId('maintenance-page')
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

async function assertDialogFitsViewport(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) {
    return;
  }
  expect(box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.height).toBeLessThanOrEqual(viewport.height);
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

test.describe('Maintenance authenticated UI', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedMaintenanceApis(page);
  });

  for (const viewport of VIEWPORTS) {
    test(`list has no horizontal overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}/maintenance`);
      await expect(
        page.getByRole('heading', { name: 'Maintenance', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Private', { exact: true })).toBeVisible();
      await assertNoHorizontalOverflow(page);
    });
  }

  for (const viewport of SCREENSHOT_VIEWPORTS) {
    test(`populated Maintenance at ${viewport.name}px`, async ({ page }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}/maintenance`);
      await expect(
        page.getByRole('heading', { name: 'Maintenance', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Replace furnace filter')).toBeVisible();
      await expect(page.getByText('Quiet leak under sink')).toBeVisible();
      await expect(page.getByText(LONG_TITLE)).toBeVisible();
      await expect(page.getByText('Fixed hallway light')).toBeVisible();
      await expect(page.getByText('Private', { exact: true })).toBeVisible();
      await expect(page.getByText(MEMBERSHIP_A)).toHaveCount(0);
      await expect(page.getByText(MEMBERSHIP_B)).toHaveCount(0);
      await assertNoHorizontalOverflow(page);
      if (viewport.width >= 1024) {
        await assertDesktopContentWidth(page);
      }
      if (viewport.width < 768) {
        await assertContentClearOfBottomNav(page);
      }
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `maintenance-${viewport.name}.png`),
        fullPage: true,
      });
    });
  }

  test('list axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/homes/${HOME_A}/maintenance`);
    await expect(
      page.getByRole('heading', { name: 'Maintenance', level: 1 }),
    ).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'maintenance list');
  });

  test('detail axe scan and long-text wrapping', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/maintenance/${FIXTURE_A.id}`);
    await expect(
      page.getByRole('heading', { name: 'Quiet leak under sink', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Private')).toBeVisible();
    await expect(page.getByText(/Keep this between us/)).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertNoSeriousAxeViolations(page, 'maintenance detail');
  });

  test('unavailable detail uses generic copy', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(
      `/homes/${HOME_A}/maintenance/ffffffff-ffff-4fff-8fff-ffffffffffff`,
    );
    await expect(
      page.getByRole('heading', {
        name: 'Maintenance item unavailable',
        level: 1,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('It may no longer be available.'),
    ).toBeVisible();
    await expect(
      page.getByText(/permission|hidden|private entry/i),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
  });

  test('200% zoom on list does not force horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/homes/${HOME_A}/maintenance`);
    await expect(
      page.getByRole('heading', { name: 'Maintenance', level: 1 }),
    ).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    await assertNoHorizontalOverflow(page);
  });

  test('create HOUSEHOLD, PRIVATE creator-only, and PRIVATE with roommate', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/maintenance`);
    await expect(
      page.getByRole('heading', { name: 'Maintenance', level: 1 }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add maintenance' }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Add maintenance' }),
    ).toBeVisible();
    await assertDialogFitsViewport(page);
    await assertNoSeriousAxeViolations(page, 'maintenance create');

    await dialog.getByRole('textbox', { name: /title/i }).fill('Household e2e');
    await dialog
      .getByRole('button', { name: 'Add maintenance', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: 'Add maintenance' }).click();
    const dialog2 = page.getByRole('dialog');
    await dialog2.getByRole('radio', { name: /Private/i }).click();
    await expect(
      dialog2.getByText('You’re included automatically.'),
    ).toBeVisible();
    await dialog2.getByRole('textbox', { name: /title/i }).fill('Solo private');
    await dialog2
      .getByRole('button', { name: 'Add maintenance', exact: true })
      .click();
    await expect(dialog2).toHaveCount(0);

    await page.getByRole('button', { name: 'Add maintenance' }).click();
    const dialog3 = page.getByRole('dialog');
    await dialog3.getByRole('radio', { name: /Private/i }).click();
    await dialog3.getByRole('checkbox', { name: 'Jamie' }).click();
    await dialog3
      .getByRole('textbox', { name: /title/i })
      .fill('Shared private');
    await dialog3
      .getByRole('button', { name: 'Add maintenance', exact: true })
      .click();
    await expect(dialog3).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
  });

  test('resolve visible OPEN item and hide Resolve afterward', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`/homes/${HOME_A}/maintenance/${FIXTURE_H.id}`);
    await expect(
      page.getByRole('heading', { name: 'Replace furnace filter', level: 1 }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Mark resolved' }).click();
    await expect(page.getByText('Resolved', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Mark resolved' }),
    ).toHaveCount(0);
    await assertNoSeriousAxeViolations(page, 'maintenance resolved detail');
  });

  test('404-on-resolve clears protected PRIVATE content', async ({ page }) => {
    await page.unroute('**/api/v1/**');
    await mockAuthenticatedMaintenanceApis(page, {
      resolveFixtureAWith404: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/maintenance/${FIXTURE_A.id}`);
    await expect(
      page.getByRole('heading', { name: 'Quiet leak under sink', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(/Keep this between us/)).toBeVisible();
    await page.getByRole('button', { name: 'Mark resolved' }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Maintenance item unavailable',
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.getByText('Quiet leak under sink')).toHaveCount(0);
    await expect(page.getByText(/Keep this between us/)).toHaveCount(0);
  });
});

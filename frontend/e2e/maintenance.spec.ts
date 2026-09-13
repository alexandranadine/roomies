import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '430', width: 430, height: 932 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;

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

async function mockAuthenticatedMaintenanceApis(page: Page): Promise<void> {
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
        },
      ]);
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
    if (path === `/api/v1/homes/${HOME_A}/maintenance`) {
      await json(route, 200, {
        items: [FIXTURE_H, FIXTURE_A],
        hasMore: false,
        nextCursor: null,
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
    if (path.includes('/maintenance/')) {
      await json(route, 404, {
        error: { code: 'NOT_FOUND', message: 'Not found' },
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
});

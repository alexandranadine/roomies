import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const LONG_EMAIL =
  'alexandra.nadine.lewis+roomies-household@example.com';
const DISPLAY_NAME = 'Alexandra Nadine Lewis';
const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'account-phase-6');
const SCREENSHOT_VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const VIEWPORTS = [
  ...SCREENSHOT_VIEWPORTS,
  { name: '430', width: 430, height: 932 },
] as const;

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuthenticatedAccountApis(page: Page): Promise<void> {
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

    if (pathName === '/api/v1/account' && method === 'DELETE') {
      await route.fulfill({ status: 204, body: '' });
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
  const width = await page.getByTestId('account-page').evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
  expect(width).toBeLessThanOrEqual(850);
  expect(width).toBeGreaterThan(600);
}

async function assertBottomNavDoesNotCoverContent(page: Page): Promise<void> {
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
    .getByTestId('account-page')
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

test.describe('account settings', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedAccountApis(page);
  });

  for (const viewport of VIEWPORTS) {
    test(`account settings has no horizontal overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/account');
      await expect(
        page.getByRole('heading', { name: 'Account', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(LONG_EMAIL)).toBeVisible();
      await assertNoHorizontalOverflow(page);

      await page.getByRole('button', { name: 'Delete account' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Delete my account' }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
    });
  }

  for (const viewport of SCREENSHOT_VIEWPORTS) {
    test(`populated Account at ${viewport.name}px`, async ({ page }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/account');
      await expect(
        page.getByRole('heading', { name: 'Account', level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: DISPLAY_NAME, level: 2 }),
      ).toBeVisible();
      await expect(page.getByText(LONG_EMAIL)).toBeVisible();
      await expect(page.getByText('Verified')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Delete account' }),
      ).toBeVisible();
      await expect(page.getByText(USER_ID)).toHaveCount(0);
      await assertNoHorizontalOverflow(page);
      if (viewport.width >= 1024) {
        await assertDesktopContentWidth(page);
      }
      if (viewport.width < 768) {
        await assertBottomNavDoesNotCoverContent(page);
      }
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `account-${viewport.name}.png`),
        fullPage: true,
      });
    });
  }

  test('gates Delete my account behind exact DELETE confirmation', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/account');
    await page.getByRole('link', { name: 'Account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Account', level: 1 }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Delete account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const submit = dialog.getByRole('button', { name: 'Delete my account' });
    const field = dialog.getByLabel(/type delete to confirm/i);
    await expect(submit).toBeDisabled();

    await field.fill('delete');
    await expect(submit).toBeDisabled();

    await field.fill('DELETE');
    await expect(submit).toBeEnabled();
  });

  test('account settings axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/account');
    await expect(
      page.getByRole('heading', { name: 'Account', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: DISPLAY_NAME, level: 2 }),
    ).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'account settings');
  });

  test('open deletion dialog axe scan excludes overlay contrast false positives', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/account');
    await page.getByRole('button', { name: 'Delete account' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Translucent dialog backdrops cause axe color-contrast false positives
    // against blended page chrome; other WCAG rules still apply.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .disableRules(['color-contrast'])
      .analyze();

    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});

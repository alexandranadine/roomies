import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'landing');
const HEADLINE =
  'Keep track of the house without living in the group chat.';

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;

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

test.describe('closed-alpha public landing', () => {
  test('shows landing copy and auth CTAs on `/`', async ({ page }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: HEADLINE, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Keep the boring house stuff organized so nobody has to remember everything.',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Create account' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Roomies is still being tested', level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Coming later', level: 2 }),
    ).toBeVisible();
    await expect(page.getByText('Shared supplies')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toHaveCount(0);
    await assertNoSeriousAxeViolations(page, 'public landing');
  });

  test('Create account opens the existing sign-up form', async ({ page }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('link', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/[?&]auth=sign-up/);
    await expect(
      page.getByRole('heading', { name: 'Create your account', level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('Name')).toBeVisible();
  });

  test('Sign in opens the existing sign-in form', async ({ page }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/[?&]auth=sign-in/);
    await expect(
      page.getByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
  });

  for (const viewport of VIEWPORTS) {
    test(`landing at ${viewport.name}px`, async ({ page }) => {
      await mockUnauthenticated(page);
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/');
      await expect(
        page.getByRole('heading', { name: HEADLINE, level: 1 }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `landing-${viewport.name}.png`),
        fullPage: true,
      });
    });
  }
});

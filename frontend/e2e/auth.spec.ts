import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'auth-phase-4');
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const HOME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOME_NAME = 'Oak Street';
const INVITED_EMAIL = 'roommate@example.com';

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

async function mockAuthenticatedEmptyHome(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const pathName = new URL(route.request().url()).pathname;
    if (pathName.endsWith('/api/v1/me')) {
      await json(route, 200, { id: USER_ID });
      return;
    }
    if (pathName.endsWith('/api/v1/me/homes')) {
      await json(route, 200, []);
      return;
    }
    await json(route, 404, {
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
  await page.route('**/api/auth/get-session', async (route) => {
    await json(route, 200, {
      user: {
        id: USER_ID,
        email: 'alex@example.com',
        emailVerified: true,
      },
    });
  });
}

async function mockInvitationPreview(page: Page): Promise<void> {
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
  await page.route(`**/api/v1/invitations/${INVITATION_ID}/preview`, async (route) => {
    await json(route, 200, {
      invitation: {
        id: INVITATION_ID,
        email: INVITED_EMAIL,
        expiresAt: '2026-10-08T00:00:00.000Z',
        home: {
          id: HOME_ID,
          name: HOME_NAME,
        },
      },
    });
  });
}

async function mockUnverifiedSession(page: Page): Promise<void> {
  await page.route('**/api/auth/get-session', async (route) => {
    await json(route, 200, {
      user: {
        id: USER_ID,
        email: INVITED_EMAIL,
        emailVerified: false,
      },
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    await json(route, 401, {
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
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

async function assertAuthCardNotFullBleed(page: Page): Promise<void> {
  const card = page.locator('main .rounded-xl').first();
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box !== null && viewport !== null && viewport.width >= 1024) {
    expect(box.width).toBeLessThan(viewport.width * 0.7);
  }
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

test.describe('signed-out auth landing', () => {
  test('shows sign-in fields and create-account control', async ({ page }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Sign in to your home.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create an account' }),
    ).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('link', { name: /notifications/i })).toHaveCount(
      0,
    );
    await assertNoSeriousAxeViolations(page, 'sign in');
  });

  test('sign-up fields stay limited to current required inputs', async ({
    page,
  }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Create your account', level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('Name')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create account' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'sign up');
  });
});

test.describe('auth onboarding screenshots and axe', () => {
  test('sign-in 360/390/1440 screenshots', async ({ page }) => {
    await mockUnauthenticated(page);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    for (const viewport of [
      { name: '360', width: 360, height: 800 },
      { name: '390', width: 390, height: 844 },
      { name: '1440', width: 1440, height: 900 },
    ] as const) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/');
      await expect(
        page.getByRole('heading', { name: 'Welcome back', level: 1 }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
      if (viewport.width >= 1024) {
        await assertAuthCardNotFullBleed(page);
      }
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `auth-signin-${viewport.name}.png`),
        fullPage: true,
      });
    }
  });

  test('sign-up 390 screenshot', async ({ page }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Create your account', level: 1 }),
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'auth-signup-390.png'),
      fullPage: true,
    });
  });

  test('verification check-email 390 screenshot and axe', async ({ page }) => {
    await mockUnverifiedSession(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/verify-email');
    await expect(
      page.getByRole('heading', { name: 'Check your email', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(INVITED_EMAIL)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Resend verification email' }),
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertNoSeriousAxeViolations(page, 'verification state');
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'auth-verify-390.png'),
      fullPage: true,
    });
  });

  test('invitation preview 390/1440 screenshots and axe', async ({ page }) => {
    await mockInvitationPreview(page);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    for (const viewport of [
      { name: '390', width: 390, height: 844 },
      { name: '1440', width: 1440, height: 900 },
    ] as const) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/invitations/${INVITATION_ID}#secret=${SECRET}`);
      await expect(
        page.getByRole('heading', {
          name: `You’re invited to join ${HOME_NAME}`,
          level: 1,
        }),
      ).toBeVisible();
      await expect(
        page.getByText(`Create your account to join ${HOME_NAME}.`),
      ).toBeVisible();
      await expect(page.getByText(INVITED_EMAIL)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Join Home' })).toHaveCount(
        0,
      );
      await expect(page.locator('body')).not.toContainText(SECRET);
      await expect(page.locator('body')).not.toContainText(HOME_ID);
      await assertNoHorizontalOverflow(page);
      if (viewport.width >= 1024) {
        await assertAuthCardNotFullBleed(page);
      }
      if (viewport.name === '390') {
        await assertNoSeriousAxeViolations(page, 'invitation preview');
      }
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `invite-${viewport.name}.png`),
        fullPage: true,
      });
    }
  });

  test('create-home 390 screenshot and axe', async ({ page }) => {
    await mockAuthenticatedEmptyHome(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Welcome to Roomies', level: 1 }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Create a home' }).click();
    await expect(
      page.getByRole('heading', { name: 'Create your home', level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel('Home name')).toBeVisible();
    await expect(page.getByLabel('Timezone')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create home' })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertNoSeriousAxeViolations(page, 'create Home');
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'create-home-390.png'),
      fullPage: true,
    });
  });
});

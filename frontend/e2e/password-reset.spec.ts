import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'password-reset');
const RESET_TOKEN = 'ResetToken1234567890abcd';

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

test.describe('password reset', () => {
  test('forgot-password link, form, generic success, and axe', async ({
    page,
  }) => {
    await mockUnauthenticated(page);
    await page.route('**/api/auth/request-password-reset', async (route) => {
      await json(route, 200, {
        status: true,
        message:
          'If this email exists in our system, check your email for the reset link',
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(
      page.getByRole('link', { name: 'Forgot password?' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(
      page.getByRole('heading', { name: 'Forgot your password?', level: 1 }),
    ).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'forgot-password');
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'forgot-390.png'),
      fullPage: true,
    });

    await page.getByLabel('Email').fill('unknown@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(
      page.getByRole('heading', { name: 'Check your email', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /if an account exists for that email, we've sent a password reset link/i,
      ),
    ).toBeVisible();
    await expect(page.getByText(/not found/i)).toHaveCount(0);
    await expect(page.getByText(/no account/i)).toHaveCount(0);
    await assertNoSeriousAxeViolations(page, 'forgot-password check-email');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'forgot-check-email-390.png'),
      fullPage: true,
    });
  });

  test('reset-password form, expired link, token not visible, and axe', async ({
    page,
  }) => {
    await mockUnauthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/reset-password?token=${RESET_TOKEN}`);
    await expect(
      page.getByRole('heading', { name: 'Choose a new password', level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel(/^New password/)).toBeVisible();
    await expect(page.getByLabel(/^Confirm new password/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(RESET_TOKEN);
    await assertNoSeriousAxeViolations(page, 'reset-password');
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'reset-390.png'),
      fullPage: true,
    });

    await page.goto('/reset-password?error=INVALID_TOKEN');
    await expect(
      page.getByRole('heading', {
        name: 'This reset link is invalid or has expired.',
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText('INVALID_TOKEN');
    await expect(
      page.getByRole('button', { name: 'Request a new link' }),
    ).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'reset-password expired-link');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'reset-expired-390.png'),
      fullPage: true,
    });
  });
});

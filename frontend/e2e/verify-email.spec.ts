import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockVerifiedSession(page: Page): Promise<void> {
  await page.route('**/api/auth/get-session', async (route) => {
    await json(route, 200, {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'roommate@example.com',
        emailVerified: true,
      },
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    await json(route, 401, {
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  });
}

test.describe('email verification return', () => {
  test('shows verified copy without exposing token query values', async ({
    page,
  }) => {
    await mockVerifiedSession(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/verify-email');
    await expect(
      page.getByRole('heading', { name: 'Verify your email', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(/your email is verified/i)).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious).toEqual([]);
  });
});

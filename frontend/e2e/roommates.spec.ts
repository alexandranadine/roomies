import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '1280', width: 1280, height: 800 },
] as const;

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuthenticatedRoommatesApis(page: Page): Promise<{
  members: { membershipId: string; name: string }[];
}> {
  const members = [
    { membershipId: MEMBERSHIP_A, name: 'Alex' },
    { membershipId: MEMBERSHIP_B, name: 'Jamie' },
  ];

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method().toUpperCase();

    if (path.endsWith('/api/v1/me') && method === 'GET') {
      await json(route, 200, { id: USER_ID });
      return;
    }
    if (path.endsWith('/api/v1/me/homes') && method === 'GET') {
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
    if (path === `/api/v1/homes/${HOME_A}/invitations` && method === 'POST') {
      await json(route, 201, {
        invitation: {
          id: INVITATION_ID,
          email: 'casey@example.com',
          expiresAt: '2026-10-01T12:00:00.000Z',
        },
        inviteUrl: `http://127.0.0.1:5173/invitations/${INVITATION_ID}#secret=share-secret`,
      });
      return;
    }
    if (
      path === `/api/v1/homes/${HOME_A}/memberships/${MEMBERSHIP_B}/role` &&
      method === 'PATCH'
    ) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (
      path === `/api/v1/homes/${HOME_A}/memberships/${MEMBERSHIP_B}/remove` &&
      method === 'POST'
    ) {
      const jamieIndex = members.findIndex(
        (row) => row.membershipId === MEMBERSHIP_B,
      );
      if (jamieIndex >= 0) {
        members.splice(jamieIndex, 1);
      }
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}/memberships` && method === 'GET') {
      await json(route, 200, {
        currentMembershipId: MEMBERSHIP_A,
        memberships: [...members],
      });
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}` && method === 'GET') {
      await json(route, 200, {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: false,
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

  return { members };
}

test.describe('Roommates management', () => {
  for (const viewport of VIEWPORTS) {
    test(`lists active roommates without overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await mockAuthenticatedRoommatesApis(page);
      await page.goto(`/homes/${HOME_A}/roommates`);

      await expect(
        page.getByRole('heading', { name: 'Roommates', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Alex')).toBeVisible();
      await expect(page.getByText('Jamie')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Invite roommate' }),
      ).toBeVisible();
    });
  }

  test('ADMIN invite, role change, and remove refresh the member list', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockAuthenticatedRoommatesApis(page);
    await page.goto(`/homes/${HOME_A}/roommates`);

    await expect(page.getByText('Jamie')).toBeVisible();

    await page.getByRole('button', { name: 'Invite roommate' }).click();
    const inviteDialog = page.getByRole('dialog', { name: 'Invite roommate' });
    await inviteDialog.getByLabel('Email').fill('casey@example.com');
    await inviteDialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(inviteDialog.getByText(/Invitation created/i)).toBeVisible();
    await expect(inviteDialog.getByLabel('Invite link')).toHaveValue(
      `http://127.0.0.1:5173/invitations/${INVITATION_ID}#secret=share-secret`,
    );
    await inviteDialog.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Actions for Jamie' }).click();
    await page.getByRole('menuitem', { name: 'Make admin' }).click();
    await expect(page.getByText('Jamie')).toBeVisible();

    await page.getByRole('button', { name: 'Actions for Jamie' }).click();
    await page.getByRole('menuitem', { name: 'Remove from Home' }).click();
    const removeDialog = page.getByRole('dialog', { name: 'Remove from Home' });
    await expect(removeDialog).toContainText('Jamie');
    await removeDialog
      .getByRole('button', { name: 'Remove from Home', exact: true })
      .click();

    await expect(page.getByText('Jamie')).toHaveCount(0);
    await expect(page.getByText('Alex')).toBeVisible();
    await expect(page.getByText(MEMBERSHIP_B)).toHaveCount(0);
  });

  test('roommates page axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockAuthenticatedRoommatesApis(page);
    await page.goto(`/homes/${HOME_A}/roommates`);
    await expect(
      page.getByRole('heading', { name: 'Roommates', level: 1 }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      serious,
      `roommates serious/critical axe violations:\n${serious
        .map((v) => `${v.id}: ${v.help}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});

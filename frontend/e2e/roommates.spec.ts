import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';
const INVITATION_ID = '018f1e2c-7e3a-7000-8000-1234567890ab';
const LONG_INVITE_SECRET = `share-secret-${'x'.repeat(160)}`;
const LONG_INVITE_URL = `http://127.0.0.1:5173/invitations/${INVITATION_ID}#secret=${LONG_INVITE_SECRET}`;
const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'roommates-phase-3');

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;

type MemberRow = { membershipId: string; name: string };

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuthenticatedRoommatesApis(
  page: Page,
  options: {
    role?: 'ADMIN' | 'ROOMMATE';
    members?: MemberRow[];
    inviteUrl?: string;
  } = {},
): Promise<{ members: MemberRow[] }> {
  const members = (options.members ?? [
    { membershipId: MEMBERSHIP_A, name: 'Alexandra Nadine Lewis' },
    { membershipId: MEMBERSHIP_B, name: 'Jamie' },
  ]).map((row) => ({ ...row }));
  const role = options.role ?? 'ADMIN';
  const inviteUrl = options.inviteUrl ?? LONG_INVITE_URL;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathName = url.pathname;
    const method = request.method().toUpperCase();

    if (pathName.endsWith('/api/v1/me') && method === 'GET') {
      await json(route, 200, { id: USER_ID });
      return;
    }
    if (pathName.endsWith('/api/v1/me/homes') && method === 'GET') {
      await json(route, 200, [
        {
          id: HOME_A,
          name: 'Oak Street',
          timezone: 'UTC',
          role,
          hasPhoto: false,
        },
      ]);
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/invitations` && method === 'POST') {
      await json(route, 201, {
        invitation: {
          id: INVITATION_ID,
          email: 'casey@example.com',
          expiresAt: '2026-10-01T12:00:00.000Z',
        },
        inviteUrl,
      });
      return;
    }
    if (
      pathName ===
        `/api/v1/homes/${HOME_A}/invitations/${INVITATION_ID}/revoke` &&
      method === 'POST'
    ) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (
      pathName === `/api/v1/homes/${HOME_A}/memberships/${MEMBERSHIP_B}/role` &&
      method === 'PATCH'
    ) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (
      pathName ===
        `/api/v1/homes/${HOME_A}/memberships/${MEMBERSHIP_B}/remove` &&
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
    if (
      pathName ===
        `/api/v1/homes/${HOME_A}/memberships/${MEMBERSHIP_A}/leave` &&
      method === 'POST'
    ) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/memberships` && method === 'GET') {
      await json(route, 200, {
        currentMembershipId: MEMBERSHIP_A,
        memberships: [...members],
      });
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}` && method === 'GET') {
      await json(route, 200, {
        id: HOME_A,
        name: 'Oak Street',
        timezone: 'UTC',
        hasPhoto: false,
      });
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/pulse`) {
      await json(route, 200, {
        generatedAt: '2026-09-14T04:00:00.000Z',
        homeLocalDate: '2026-09-14',
        items: [],
      });
      return;
    }
    if (pathName === '/api/v1/notifications') {
      await json(route, 200, { items: [], hasMore: false, nextCursor: null });
      return;
    }
    if (pathName.endsWith('/activity')) {
      await json(route, 200, { items: [], hasMore: false, nextCursor: null });
      return;
    }

    await json(route, 404, {
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });

  return { members };
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

async function assertContentClearOfBottomNav(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Home' });
  const position = await nav.evaluate((element) => {
    return window.getComputedStyle(element).position;
  });
  if (position !== 'fixed') {
    return;
  }

  const paddingBottom = await page
    .getByTestId('roommates-page')
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

  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });

  const navBox = await nav.boundingBox();
  const lastSection = page
    .locator('[data-testid="roommates-page"] > section')
    .last();
  const sectionBox = await lastSection.boundingBox();
  expect(navBox).not.toBeNull();
  expect(sectionBox).not.toBeNull();
  if (navBox === null || sectionBox === null) {
    return;
  }
  expect(sectionBox.y + sectionBox.height).toBeLessThanOrEqual(navBox.y + 1);
}

async function assertDesktopContentWidth(page: Page): Promise<void> {
  const width = await page
    .getByTestId('roommates-page')
    .evaluate((element) => {
      return element.getBoundingClientRect().width;
    });
  expect(width).toBeLessThanOrEqual(1050);
  expect(width).toBeGreaterThan(800);
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

async function assertMenuFitsViewport(page: Page): Promise<void> {
  const menu = page.getByRole('menu');
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) {
    return;
  }
  expect(box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
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

test.describe('Roommates management', () => {
  test('ADMIN invite, copy, revoke, role change, and remove stay intact', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedRoommatesApis(page, {
      members: [
        { membershipId: MEMBERSHIP_A, name: 'Alex' },
        { membershipId: MEMBERSHIP_B, name: 'Jamie' },
      ],
    });
    await page.goto(`/homes/${HOME_A}/roommates`);

    await expect(page.getByText('Jamie')).toBeVisible();
    await expect(page.getByText('You', { exact: true })).toBeVisible();
    await expect(page.getByText(MEMBERSHIP_A)).toHaveCount(0);
    await expect(page.getByText(MEMBERSHIP_B)).toHaveCount(0);
    await expect(page.getByText(USER_ID)).toHaveCount(0);

    await page.getByRole('button', { name: 'Invite roommate' }).click();
    const inviteDialog = page.getByRole('dialog', { name: 'Invite roommate' });
    await inviteDialog.getByLabel('Email').fill('casey@example.com');
    await inviteDialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(inviteDialog.getByText(/Invitation created/i)).toBeVisible();
    await expect(inviteDialog.getByLabel('Invite link')).toHaveValue(
      LONG_INVITE_URL,
    );
    await assertDialogFitsViewport(page);
    await inviteDialog.getByRole('button', { name: 'Copy invite link' }).click();
    await expect(
      inviteDialog.getByRole('button', { name: 'Copied' }),
    ).toBeVisible();
    await inviteDialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(page.getByText(/Invite pending/i)).toBeVisible();
    await expect(page.getByLabel('Invite link')).toHaveValue(LONG_INVITE_URL);
    await assertNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Revoke invite' }).click();
    const revokeDialog = page.getByRole('dialog', { name: 'Revoke invite?' });
    await expect(revokeDialog).toContainText('casey@example.com');
    await assertDialogFitsViewport(page);
    await revokeDialog
      .getByRole('button', { name: 'Revoke invite', exact: true })
      .click();
    await expect(page.getByText(/Invite pending/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Actions for Jamie' }).click();
    await assertMenuFitsViewport(page);
    await page.getByRole('menuitem', { name: 'Make admin' }).click();
    await expect(page.getByText('Jamie')).toBeVisible();

    await page.getByRole('button', { name: 'Actions for Jamie' }).click();
    await page.getByRole('menuitem', { name: 'Remove from Home' }).click();
    const removeDialog = page.getByRole('dialog', { name: 'Remove from Home' });
    await expect(removeDialog).toContainText('Jamie');
    await assertDialogFitsViewport(page);
    await removeDialog
      .getByRole('button', { name: 'Remove from Home', exact: true })
      .click();

    await expect(page.getByText('Jamie')).toHaveCount(0);
    await expect(page.getByText('Alex')).toBeVisible();
    await expect(page.getByText(MEMBERSHIP_B)).toHaveCount(0);
  });

  test('ROOMMATE cannot invite or manage other roommates', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedRoommatesApis(page, {
      role: 'ROOMMATE',
      members: [
        { membershipId: MEMBERSHIP_A, name: 'Alex' },
        { membershipId: MEMBERSHIP_B, name: 'Jamie' },
      ],
    });
    await page.goto(`/homes/${HOME_A}/roommates`);

    await expect(page.getByText('Jamie')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Invite roommate' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Actions for Jamie' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Leave Home' })).toBeVisible();
  });

  test('populated roster axe scan (serious/critical)', async ({ page }) => {
    await mockAuthenticatedRoommatesApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/roommates`);
    await expect(
      page.getByRole('heading', { name: 'Roommates', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Alexandra Nadine Lewis')).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'roommates populated roster');
  });

  test('invite flow axe scan (serious/critical)', async ({ page }) => {
    await mockAuthenticatedRoommatesApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/roommates`);
    await page.getByRole('button', { name: 'Invite roommate' }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite roommate' });
    await expect(dialog.getByLabel('Email')).toBeVisible();
    await assertDialogFitsViewport(page);
    await assertNoSeriousAxeViolations(page, 'roommates invite dialog');
    await dialog.getByLabel('Email').fill('casey@example.com');
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog.getByText(/Invitation created/i)).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'roommates invite created');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(/Invite pending/i)).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'roommates pending invite panel');
  });

  test('action menu and remove dialog axe scan (serious/critical)', async ({
    page,
  }) => {
    await mockAuthenticatedRoommatesApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/roommates`);
    await page.getByRole('button', { name: 'Actions for Jamie' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await assertMenuFitsViewport(page);
    await page.getByRole('menuitem', { name: 'Remove from Home' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    const removeDialog = page.getByRole('dialog', { name: 'Remove from Home' });
    await expect(removeDialog).toBeVisible();
    await assertDialogFitsViewport(page);
    await assertNoSeriousAxeViolations(page, 'roommates remove dialog');
  });

  test('Leave Home dialog fits the viewport', async ({ page }) => {
    await mockAuthenticatedRoommatesApis(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/homes/${HOME_A}/roommates`);
    await page.getByRole('button', { name: 'Leave Home' }).click();
    await expect(page.getByRole('dialog', { name: 'Leave Home' })).toBeVisible();
    await assertDialogFitsViewport(page);
    await assertNoSeriousAxeViolations(page, 'roommates leave dialog');
  });

  for (const viewport of VIEWPORTS) {
    test(`populated Roommates at ${viewport.name}px`, async ({ page }) => {
      await mockAuthenticatedRoommatesApis(page);
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}/roommates`);
      await expect(
        page.getByRole('heading', { name: 'Roommates', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Alexandra Nadine Lewis')).toBeVisible();
      await expect(page.getByText('Jamie')).toBeVisible();
      await expect(page.getByText('You', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: '2 roommates' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Invite roommate' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Leave Home' })).toBeVisible();
      await expect(page.getByText(MEMBERSHIP_A)).toHaveCount(0);
      await assertNoHorizontalOverflow(page);
      if (viewport.width >= 1024) {
        await assertDesktopContentWidth(page);
        const currentCard = page
          .locator('li')
          .filter({ hasText: 'Alexandra Nadine Lewis' });
        const otherCard = page.locator('li').filter({ hasText: 'Jamie' });
        const currentBox = await currentCard.boundingBox();
        const otherBox = await otherCard.boundingBox();
        expect(currentBox).not.toBeNull();
        expect(otherBox).not.toBeNull();
        if (currentBox !== null && otherBox !== null) {
          expect(Math.abs(currentBox.y - otherBox.y)).toBeLessThan(24);
        }
      }
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `roommates-${viewport.name}.png`),
        fullPage: true,
      });
      if (viewport.width < 768) {
        await assertContentClearOfBottomNav(page);
      }
    });
  }
});

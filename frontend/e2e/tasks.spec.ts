import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';
const CREATED_ID = 'c1111111-1111-4111-8111-111111111111';
const SCREENSHOT_DIR = path.join('e2e', 'screenshots', 'tasks-phase-2');

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;

type TaskRow = {
  id: string;
  title: string;
  status: 'OPEN' | 'COMPLETED';
  source: 'MANUAL' | 'RECURRING';
  scheduledFor: string | null;
  assignedMembershipId: string | null;
  createdAt: string;
  updatedAt: string;
};

type DefinitionRow = {
  id: string;
  title: string;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  weekday: number | null;
  dayOfMonth: number | null;
  assignedMembershipId: string | null;
  creatorMembershipId: string;
  nextOccurrenceDate: string | null;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const POPULATED_TASKS: TaskRow[] = [
  {
    id: 't1111111-1111-4111-8111-111111111111',
    title: 'Take out trash',
    status: 'OPEN',
    source: 'MANUAL',
    scheduledFor: '2020-01-15',
    assignedMembershipId: MEMBERSHIP_B,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-10T15:30:00.000Z',
  },
  {
    id: 't2222222-2222-4222-8222-222222222222',
    title: 'Wipe counters',
    status: 'OPEN',
    source: 'MANUAL',
    scheduledFor: null,
    assignedMembershipId: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-10T15:30:00.000Z',
  },
  {
    id: 't3333333-3333-4333-8333-333333333333',
    title: 'Run dishwasher',
    status: 'OPEN',
    source: 'MANUAL',
    scheduledFor: null,
    assignedMembershipId: MEMBERSHIP_A,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-10T15:30:00.000Z',
  },
  {
    id: 't5555555-5555-4555-8555-555555555555',
    title: 'Weekly trash',
    status: 'OPEN',
    source: 'RECURRING',
    scheduledFor: '2026-09-28',
    assignedMembershipId: MEMBERSHIP_A,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-10T15:30:00.000Z',
  },
  {
    id: 't4444444-4444-4444-8444-444444444444',
    title: 'Sweep hallway',
    status: 'COMPLETED',
    source: 'MANUAL',
    scheduledFor: '2026-09-10',
    assignedMembershipId: MEMBERSHIP_B,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-10T18:00:00.000Z',
  },
];

const POPULATED_DEFINITIONS: DefinitionRow[] = [
  {
    id: 'd1111111-1111-4111-8111-111111111111',
    title: 'Weekly trash',
    frequency: 'WEEKLY',
    weekday: 2,
    dayOfMonth: null,
    assignedMembershipId: MEMBERSHIP_B,
    creatorMembershipId: MEMBERSHIP_A,
    nextOccurrenceDate: '2026-09-29',
    deactivatedAt: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
  },
  {
    id: 'd4444444-4444-4444-8444-444444444444',
    title: 'Clean kitchen',
    frequency: 'MONTHLY',
    weekday: null,
    dayOfMonth: 1,
    assignedMembershipId: null,
    creatorMembershipId: MEMBERSHIP_A,
    nextOccurrenceDate: '2026-10-01',
    deactivatedAt: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
  },
];

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuthenticatedTasksApis(
  page: Page,
  options: { populated?: boolean } = {},
): Promise<{ tasks: TaskRow[] }> {
  const tasks: TaskRow[] = options.populated
    ? POPULATED_TASKS.map((task) => ({ ...task }))
    : [];
  const definitions: DefinitionRow[] = options.populated
    ? POPULATED_DEFINITIONS.map((row) => ({ ...row }))
    : [];

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathName = url.pathname;
    const method = request.method();

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
    if (pathName === `/api/v1/homes/${HOME_A}/pulse`) {
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
    if (pathName === `/api/v1/homes/${HOME_A}/memberships` && method === 'GET') {
      await json(route, 200, {
        currentMembershipId: MEMBERSHIP_A,
        memberships: [
          { membershipId: MEMBERSHIP_A, name: 'Alex' },
          { membershipId: MEMBERSHIP_B, name: 'Jamie' },
        ],
      });
      return;
    }
    if (
      pathName === `/api/v1/homes/${HOME_A}/task-definitions` &&
      method === 'GET'
    ) {
      await json(route, 200, definitions);
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/tasks` && method === 'POST') {
      const body = request.postDataJSON() as {
        title: string;
        assignedMembershipId: string | null;
        scheduledFor: string | null;
      };
      const created: TaskRow = {
        id: CREATED_ID,
        title: body.title,
        status: 'OPEN',
        source: 'MANUAL',
        scheduledFor: body.scheduledFor,
        assignedMembershipId: body.assignedMembershipId,
        createdAt: '2026-09-24T12:00:00.000Z',
        updatedAt: '2026-09-24T12:00:00.000Z',
      };
      tasks.unshift(created);
      await json(route, 201, created);
      return;
    }
    if (pathName === `/api/v1/homes/${HOME_A}/tasks` && method === 'GET') {
      await json(route, 200, tasks);
      return;
    }
    if (
      pathName === `/api/v1/homes/${HOME_A}/tasks/${CREATED_ID}/complete` &&
      method === 'POST'
    ) {
      const current = tasks.find((task) => task.id === CREATED_ID);
      if (current === undefined) {
        await json(route, 404, {
          error: { code: 'NOT_FOUND', message: 'Not found' },
        });
        return;
      }
      current.status = 'COMPLETED';
      current.updatedAt = '2026-09-24T13:00:00.000Z';
      await json(route, 200, current);
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

  return { tasks };
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

  const paddingBottom = await page.getByTestId('tasks-page').evaluate((element) => {
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
    .locator('[data-testid="tasks-page"] > section')
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
  const width = await page.getByTestId('tasks-page').evaluate((element) => {
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

test.describe('Tasks authenticated UI', () => {
  test('empty list has no horizontal overflow at 360 and 390', async ({
    page,
  }) => {
    await mockAuthenticatedTasksApis(page);
    for (const viewport of VIEWPORTS.filter(
      (item) => item.name === '360' || item.name === '390',
    )) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}/tasks`);
      await expect(
        page.getByRole('heading', { name: 'Tasks', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Nothing on the list.')).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await assertContentClearOfBottomNav(page);
    }
  });

  test('list axe scan (serious/critical)', async ({ page }) => {
    await mockAuthenticatedTasksApis(page, { populated: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/tasks`);
    await expect(
      page.getByRole('heading', { name: 'Tasks', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Take out trash')).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'tasks populated list');
  });

  test('create form axe scan (serious/critical)', async ({ page }) => {
    await mockAuthenticatedTasksApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/tasks`);
    await page.getByRole('button', { name: 'Add task' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add task' })).toBeVisible();
    await assertDialogFitsViewport(page);
    await assertNoSeriousAxeViolations(page, 'tasks create form');
  });

  test('Roommate can create, assign, complete, and see done', async ({
    page,
  }) => {
    await mockAuthenticatedTasksApis(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}`);
    await expect(
      page.getByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Tasks', level: 1 }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add task' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add task' })).toBeVisible();
    await assertDialogFitsViewport(page);

    await dialog.getByRole('textbox', { name: /title/i }).fill('Take out trash');
    await dialog.getByLabel(/assigned to/i).selectOption({ label: 'Jamie' });
    await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByText('Take out trash')).toBeVisible();
    await expect(page.getByText('Jamie')).toBeVisible();
    await expect(page.getByText(MEMBERSHIP_A)).toHaveCount(0);
    await expect(page.getByText(MEMBERSHIP_B)).toHaveCount(0);
    await expect(page.getByText(CREATED_ID)).toHaveCount(0);

    await page.getByRole('button', { name: 'Mark Take out trash done' }).click();
    await expect(
      page.getByRole('heading', { name: 'Completed 1' }),
    ).toBeVisible();
    await expect(page.getByText('Take out trash')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Mark Take out trash done' }),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await assertNoSeriousAxeViolations(page, 'tasks completed list');
  });

  for (const viewport of VIEWPORTS) {
    test(`populated Tasks at ${viewport.name}px`, async ({ page }) => {
      await mockAuthenticatedTasksApis(page, { populated: true });
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}/tasks`);
      await expect(
        page.getByRole('heading', { name: 'Tasks', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('Take out trash')).toBeVisible();
      await expect(page.getByText('Overdue')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Open 4' })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Completed 1' }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Repeating tasks 2' }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
      if (viewport.width >= 1024) {
        await assertDesktopContentWidth(page);
      }
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `tasks-${viewport.name}.png`),
        fullPage: true,
      });
      if (viewport.width < 768) {
        await assertContentClearOfBottomNav(page);
      }
    });
  }
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const HOME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP_A = 'm1111111-1111-4111-8111-111111111111';
const MEMBERSHIP_B = 'm2222222-2222-4222-8222-222222222222';
const CREATED_ID = 'c1111111-1111-4111-8111-111111111111';

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
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

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockAuthenticatedTasksApis(page: Page): Promise<void> {
  const tasks: TaskRow[] = [];

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
          role: 'ROOMMATE',
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
    if (path === `/api/v1/homes/${HOME_A}/task-definitions` && method === 'GET') {
      await json(route, 200, []);
      return;
    }
    if (path === `/api/v1/homes/${HOME_A}/tasks` && method === 'POST') {
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
    if (path === `/api/v1/homes/${HOME_A}/tasks` && method === 'GET') {
      await json(route, 200, tasks);
      return;
    }
    if (
      path === `/api/v1/homes/${HOME_A}/tasks/${CREATED_ID}/complete` &&
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

test.describe('Tasks authenticated UI', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedTasksApis(page);
  });

  for (const viewport of VIEWPORTS) {
    test(`empty list has no horizontal overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`/homes/${HOME_A}/tasks`);
      await expect(
        page.getByRole('heading', { name: 'Tasks', level: 1 }),
      ).toBeVisible();
      await expect(page.getByText('No tasks yet')).toBeVisible();
      await assertNoHorizontalOverflow(page);
    });
  }

  test('list axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/homes/${HOME_A}/tasks`);
    await expect(
      page.getByRole('heading', { name: 'Tasks', level: 1 }),
    ).toBeVisible();
    await assertNoSeriousAxeViolations(page, 'tasks empty list');
  });

  test('Roommate can create, assign, complete, and see done', async ({
    page,
  }) => {
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
    await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();
    await expect(page.getByText('Take out trash')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Mark Take out trash done' }),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await assertNoSeriousAxeViolations(page, 'tasks completed list');
  });
});

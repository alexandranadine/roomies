import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: '360', width: 360, height: 800 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
] as const;

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

test.describe('foundation shell', () => {
  for (const viewport of VIEWPORTS) {
    test(`root loads without horizontal overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/');
      await expect(
        page.getByRole('heading', { name: 'Roomies', level: 1 }),
      ).toBeVisible();
      await assertNoHorizontalOverflow(page);
    });
  }

  test('root shell axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await assertNoSeriousAxeViolations(page, 'root shell');
  });

  test('desktop shell renders branding at ~1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('banner')).toContainText('Roomies');
    await expect(
      page.getByRole('heading', { name: 'Roomies', level: 1 }),
    ).toBeVisible();
  });
});

test.describe('dev UI fixture', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/__dev/ui');
    await expect(
      page.getByRole('heading', { name: 'UI primitives fixture', level: 1 }),
    ).toBeVisible();
  });

  for (const viewport of VIEWPORTS.filter(
    (v) => v.width <= 430 || v.width === 1280,
  )) {
    test(`fixture has no horizontal overflow at ${viewport.name}px`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto('/__dev/ui');
      await assertNoHorizontalOverflow(page);
    });
  }

  test('keyboard focus is visible on interactive controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const primary = page.getByRole('button', { name: 'Primary' }).first();
    await primary.focus();
    await expect(primary).toBeFocused();

    const outline = await primary.evaluate((el) => {
      const styles = getComputedStyle(el);
      return {
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        boxShadow: styles.boxShadow,
      };
    });

    const hasVisibleFocus =
      (outline.outlineStyle !== 'none' && outline.outlineWidth !== '0px') ||
      outline.boxShadow !== 'none';
    expect(hasVisibleFocus).toBe(true);
  });

  test('Dialog opens and closes via keyboard', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const trigger = page.getByRole('button', { name: 'Open dialog' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Example dialog' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('Sheet fits within mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole('button', { name: 'Open sheet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Example sheet' });
    await expect(dialog).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(360 + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(800 + 1);
    }

    await page.keyboard.press('Escape');
  });

  test('Menu keyboard interaction works', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const trigger = page.getByRole('button', { name: 'Open menu' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const edit = page.getByRole('menuitem', { name: 'Edit' });
    await expect(edit).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(edit).toBeHidden();
  });

  test('Tabs keyboard interaction works', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const openTab = page.getByRole('tab', { name: 'Open' });
    const doneTab = page.getByRole('tab', { name: 'Completed' });
    await openTab.focus();
    await expect(openTab).toHaveAttribute('aria-selected', 'true');

    // Base UI Tabs use manual activation: arrows move focus; Enter selects.
    await page.keyboard.press('ArrowRight');
    await expect(doneTab).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(doneTab).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('tabpanel', { name: 'Completed' }),
    ).toBeVisible();
  });

  test('fixture axe scan (serious/critical)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await assertNoSeriousAxeViolations(page, 'UI fixture');
  });
});

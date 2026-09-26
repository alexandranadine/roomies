import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './button.js';
import { Sheet } from './sheet.js';

function expectPageScrollLocked(locked: boolean): void {
  const html = document.documentElement;
  const body = document.body;
  const hasLockAttribute = html.hasAttribute('data-base-ui-scroll-locked');
  const htmlOverflow = html.style.overflowY;
  const bodyOverflow = body.style.overflowY;
  const overflowHidden =
    htmlOverflow === 'hidden' ||
    bodyOverflow === 'hidden' ||
    html.style.overflowX === 'hidden' ||
    body.style.overflowX === 'hidden';

  if (locked) {
    expect(hasLockAttribute || overflowHidden).toBe(true);
  } else {
    expect(hasLockAttribute).toBe(false);
    expect(htmlOverflow).not.toBe('hidden');
    expect(bodyOverflow).not.toBe('hidden');
  }
}

describe('Sheet', () => {
  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();

    render(
      <Sheet.Root>
        <Sheet.Trigger render={<Button>Open sheet</Button>} />
        <Sheet.Popup title="Example sheet" side="bottom">
          <p>Sheet body</p>
        </Sheet.Popup>
      </Sheet.Root>,
    );

    const trigger = screen.getByRole('button', { name: 'Open sheet' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('locks page scroll while open via Base UI scroll lock', async () => {
    const user = userEvent.setup();

    render(
      <Sheet.Root>
        <Sheet.Trigger render={<Button>Open sheet</Button>} />
        <Sheet.Popup title="Example sheet" side="right">
          <p>Sheet body</p>
        </Sheet.Popup>
      </Sheet.Root>,
    );

    expectPageScrollLocked(false);

    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    await screen.findByRole('dialog');

    await waitFor(() => {
      expectPageScrollLocked(true);
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expectPageScrollLocked(false);
    });
  });
});

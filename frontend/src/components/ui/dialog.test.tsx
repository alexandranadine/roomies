import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './button.js';
import { Dialog } from './dialog.js';

function roomiesDialogBackdrop(): HTMLElement {
  const backdrop = document.querySelector(
    '[role="presentation"].fixed.inset-0.z-40',
  );
  if (backdrop === null) {
    throw new Error('Expected the Roomies dialog backdrop to be present');
  }
  return backdrop as HTMLElement;
}

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

describe('Dialog', () => {
  it('opens with focus, closes on Escape, and restores focus', async () => {
    const user = userEvent.setup();

    render(
      <Dialog.Root>
        <Dialog.Trigger render={<Button>Open dialog</Button>} />
        <Dialog.Popup title="Confirm action" description="Optional details">
          <p>Dialog body</p>
        </Dialog.Popup>
      </Dialog.Root>,
    );

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Confirm action' }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('closes on backdrop click (pointer dismiss)', async () => {
    const user = userEvent.setup();

    render(
      <Dialog.Root>
        <Dialog.Trigger render={<Button>Open dialog</Button>} />
        <Dialog.Popup title="Confirm action" description="Optional details">
          <p>Dialog body</p>
        </Dialog.Popup>
      </Dialog.Root>,
    );

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    await user.click(roomiesDialogBackdrop());

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Base UI pointer dismiss closes the dialog but does not restore trigger
    // focus (Escape does — see test above). Document actual behavior; do not
    // patch around the library here.
    expect(document.activeElement).toBe(document.body);
  });

  it('locks page scroll while open via Base UI scroll lock', async () => {
    const user = userEvent.setup();

    render(
      <Dialog.Root>
        <Dialog.Trigger render={<Button>Open dialog</Button>} />
        <Dialog.Popup title="Confirm action">
          <p>Dialog body</p>
        </Dialog.Popup>
      </Dialog.Root>,
    );

    expectPageScrollLocked(false);

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
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

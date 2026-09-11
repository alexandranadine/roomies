import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './button.js';
import { Dialog } from './dialog.js';

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
});

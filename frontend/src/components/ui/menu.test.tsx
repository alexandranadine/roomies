import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './button.js';
import { Menu } from './menu.js';

describe('Menu', () => {
  it('supports keyboard interaction', async () => {
    const user = userEvent.setup();

    render(
      <Menu.Root>
        <Menu.Trigger render={<Button>Actions</Button>} />
        <Menu.Popup>
          <Menu.Item>Edit</Menu.Item>
          <Menu.Item>Archive</Menu.Item>
        </Menu.Popup>
      </Menu.Root>,
    );

    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus();
    });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button.js';

describe('Button', () => {
  it('renders variants and exposes disabled/loading contracts', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    const { rerender } = render(
      <Button variant="primary" onClick={onClick}>
        Save
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    rerender(
      <Button variant="secondary" disabled onClick={onClick}>
        Save
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    rerender(
      <Button variant="danger" loading onClick={onClick}>
        Save
      </Button>,
    );

    const busy = screen.getByRole('button', { name: 'Save' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.querySelector('[aria-hidden="true"]')).toBeTruthy();

    await user.click(busy);
    expect(onClick).not.toHaveBeenCalled();
  });
});

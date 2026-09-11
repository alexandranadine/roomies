import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Checkbox } from './checkbox.js';

describe('Checkbox', () => {
  it('is keyboard operable', async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Subscribe to updates" />);

    const checkbox = screen.getByRole('checkbox', {
      name: 'Subscribe to updates',
    });
    expect(checkbox).not.toBeChecked();

    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();

    await user.keyboard(' ');
    expect(checkbox).not.toBeChecked();
  });
});

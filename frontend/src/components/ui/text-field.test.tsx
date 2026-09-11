import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextField } from './text-field.js';

describe('TextField', () => {
  it('associates label, helper, and error text via ARIA', () => {
    render(
      <TextField
        label="Email"
        helperText="Used for notifications"
        invalid
        errorText="Enter a valid email"
        defaultValue="bad"
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input).toHaveAttribute('aria-invalid', 'true');

    const helper = screen.getByText('Used for notifications');
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('Enter a valid email');

    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(describedBy?.split(' ')).toEqual(
      expect.arrayContaining([helper.id, error.id]),
    );
  });

  it('exposes accessible invalid state without an error message alone', () => {
    render(<TextField label="Name" invalid defaultValue="" />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});

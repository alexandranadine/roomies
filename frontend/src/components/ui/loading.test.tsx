import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button.js';
import { Spinner } from './spinner.js';

describe('loading affordances', () => {
  it('exposes busy semantics on loading buttons and status on spinner', () => {
    render(
      <>
        <Button loading>Submit</Button>
        <Spinner label="Fetching" />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Submit' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Fetching');
  });
});

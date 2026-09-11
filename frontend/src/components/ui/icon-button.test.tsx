import { Search } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IconButton } from './icon-button.js';

describe('IconButton', () => {
  it('requires and exposes an accessible name', () => {
    render(
      <IconButton aria-label="Search items">
        <Search aria-hidden="true" />
      </IconButton>,
    );

    expect(
      screen.getByRole('button', { name: 'Search items' }),
    ).toBeInTheDocument();
  });

  it('supports aria-labelledby as an accessible name', () => {
    render(
      <>
        <span id="icon-btn-label">Open filters</span>
        <IconButton aria-labelledby="icon-btn-label">
          <Search aria-hidden="true" />
        </IconButton>
      </>,
    );

    expect(
      screen.getByRole('button', { name: 'Open filters' }),
    ).toBeInTheDocument();
  });
});

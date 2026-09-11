import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tabs } from './tabs.js';

describe('Tabs', () => {
  it('exposes correct ARIA roles and selected state', async () => {
    const user = userEvent.setup();

    render(
      <Tabs.Root defaultValue="open">
        <Tabs.List>
          <Tabs.Tab value="open">Open</Tabs.Tab>
          <Tabs.Tab value="done">Completed</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="open">Open panel</Tabs.Panel>
        <Tabs.Panel value="done">Completed panel</Tabs.Panel>
      </Tabs.Root>,
    );

    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeInTheDocument();

    const openTab = screen.getByRole('tab', { name: 'Open' });
    const doneTab = screen.getByRole('tab', { name: 'Completed' });

    expect(openTab).toHaveAttribute('aria-selected', 'true');
    expect(doneTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Open panel');

    await user.click(doneTab);

    expect(doneTab).toHaveAttribute('aria-selected', 'true');
    expect(openTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Completed panel');
  });
});

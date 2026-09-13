import { NavLink } from 'react-router';
import { cn } from '../components/ui/cn.js';

export type HomePrimaryNavProps = {
  homeId: string;
};

/**
 * Home-scoped primary destinations.
 * Only live routes are linked — no dead destination controls.
 */
export function HomePrimaryNav({ homeId }: HomePrimaryNavProps) {
  const base = `/homes/${encodeURIComponent(homeId)}`;

  return (
    <nav aria-label="Home" className="border-b border-border">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        <li>
          <NavLink
            to={base}
            end
            className={({ isActive }) =>
              cn(
                'relative inline-flex min-h-control-lg items-center px-3 text-sm font-medium outline-none',
                'text-text-muted hover:text-text-primary',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent',
                isActive && 'text-text-primary after:bg-brand',
              )
            }
          >
            Home
          </NavLink>
        </li>
        <li>
          <NavLink
            to={`${base}/maintenance`}
            className={({ isActive }) =>
              cn(
                'relative inline-flex min-h-control-lg items-center px-3 text-sm font-medium outline-none',
                'text-text-muted hover:text-text-primary',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent',
                isActive && 'text-text-primary after:bg-brand',
              )
            }
          >
            Maintenance
          </NavLink>
        </li>
      </ul>
    </nav>
  );
}

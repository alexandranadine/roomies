import { NavLink } from 'react-router';
import { cn } from '../components/ui/cn.js';
import { HOME_NAV_DESTINATIONS } from './home-nav.js';

export type HomeDesktopNavProps = {
  homeId: string;
};

/**
 * Header-adjacent destinations for tablet/desktop. Mobile uses the bottom bar.
 */
export function HomeDesktopNav({ homeId }: HomeDesktopNavProps) {
  return (
    <nav aria-label="Home" className="border-b border-border">
      <ul className="flex gap-1">
        {HOME_NAV_DESTINATIONS.map((destination) => {
          const Icon = destination.icon;
          return (
            <li key={destination.id}>
              <NavLink
                to={destination.to(homeId)}
                end={destination.end}
                aria-label={destination.accessibleName}
                className={({ isActive }) =>
                  cn(
                    'relative inline-flex min-h-control-lg items-center gap-1.5 px-3 text-sm font-medium outline-none',
                    'text-text-muted hover:text-text-primary',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent',
                    isActive && 'text-text-primary after:bg-brand',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      className={cn('size-4', isActive && 'fill-current')}
                      aria-hidden="true"
                    />
                    <span>{destination.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

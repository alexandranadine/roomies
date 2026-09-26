import { NavLink } from 'react-router';
import { cn } from '../components/ui/cn.js';
import { HOME_NAV_DESTINATIONS } from './home-nav.js';

export type HomeDesktopNavProps = {
  homeId: string;
  variant?: 'tabs' | 'inline';
};

/**
 * Header-adjacent destinations for tablet/desktop. Mobile uses the bottom bar.
 */
export function HomeDesktopNav({
  homeId,
  variant = 'tabs',
}: HomeDesktopNavProps) {
  const inline = variant === 'inline';

  return (
    <nav aria-label="Home" className={inline ? undefined : 'border-b border-border'}>
      <ul className={cn('flex', inline ? 'gap-0.5' : 'gap-1')}>
        {HOME_NAV_DESTINATIONS.map((destination) => (
          <li key={destination.id}>
            <NavLink
              to={destination.to(homeId)}
              end={destination.end}
              aria-label={destination.accessibleName}
              className={({ isActive }) =>
                cn(
                  'relative inline-flex items-center gap-1.5 text-sm font-medium outline-none',
                  'text-text-muted hover:text-text-primary',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  inline
                    ? 'h-16 px-3'
                    : 'min-h-control-lg px-3',
                  'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent',
                  isActive && 'text-text-primary after:bg-brand',
                )
              }
            >
              {({ isActive }) => {
                const Icon = isActive
                  ? destination.iconSolid
                  : destination.iconOutline;
                return (
                  <>
                    <Icon className="size-4" aria-hidden="true" />
                    <span>{destination.label}</span>
                  </>
                );
              }}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
